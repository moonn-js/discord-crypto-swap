import 'dotenv/config';
import { ChangellyClient, matchChangellyAsset, netPayout } from '../src/services/changelly-client.js';
import { quotedRouteCostBps } from '../src/utils/amounts.js';

// Read-only: never creates orders or sends funds. Prices are indicative catalogue
// USD marks, not a guaranteed executable market benchmark.
const client = new ChangellyClient({ changellyEnabled: true, changellyPrivateKeyHex: process.env.CHANGELLY_PRIVATE_KEY_HEX });
if (!client.enabled) throw new Error('Set CHANGELLY_PRIVATE_KEY_HEX in the ignored .env first.');
const tokensResponse = await globalThis.fetch('https://1click.chaindefuser.com/v0/tokens', { signal: globalThis.AbortSignal.timeout(15_000) });
if (!tokensResponse.ok) throw new Error('Could not fetch reference token prices.');
const tokens = await tokensResponse.json();
const currencies = await client.getCurrencies();
const origin = tokens.find((asset) => asset.blockchain === 'ltc' && asset.symbol === 'LTC' && !asset.contractAddress);
if (!origin) throw new Error('Native LTC is absent from the reference catalogue.');
print('Current account pricing; zero partner commission must be confirmed by ChangeNOW. No orders are created.');
print(`Reference LTC price: $${origin.price} (${origin.priceUpdatedAt}). Costs exclude the sender wallet transaction fee.`);
for (const blockchain of ['bsc', 'sol']) {
  const destination = tokens.find((asset) => asset.blockchain === blockchain && asset.symbol === 'USDT');
  const match = destination && matchChangellyAsset(destination, currencies, 'buy');
  if (!match) continue;
  for (const fromAmount of ['1', '10', '100']) {
    try {
      const from = matchChangellyAsset(origin, currencies, 'sell');
      if (!from) throw new Error('Unsupported LTC metadata');
      const results = await client.rpc('getExchangeAmount', { from: from.ticker, to: match.ticker, amountFrom: fromAmount });
      if (!Array.isArray(results) || results.length !== 1 || results[0].from !== from.ticker || results[0].to !== match.ticker) throw new Error('Invalid quote');
      const estimate = {toAmount: netPayout(results[0].amountTo, results[0].networkFee, destination.decimals), withdrawalFee: results[0].networkFee};
      const bps = quotedRouteCostBps({ amountInUsd: (Number(fromAmount) * Number(origin.price)).toFixed(8), amountOutUsd: (Number(estimate.toAmount) * Number(destination.price)).toFixed(8) });
      print(JSON.stringify({ checkedAt: new Date().toISOString(), fromLtc: fromAmount, toNetwork: blockchain, toUsdt: estimate.toAmount, indicativeCostPercent: bps === null ? null : bps / 100, depositFeeLtc: estimate.depositFee, withdrawalFeeUsdt: estimate.withdrawalFee, forecastMinutes: estimate.transactionSpeedForecast }));
    } catch (error) { print(JSON.stringify({ fromLtc: fromAmount, toNetwork: blockchain, errorCode: error.code ?? 'REQUEST_FAILED' })); }
  }
}

function print(value) { process.stdout.write(`${value}\n`); }
