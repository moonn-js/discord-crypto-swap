import 'dotenv/config';
import { ChangeNowClient, matchChangeNowAsset } from '../src/services/changenow-client.js';
import { quotedRouteCostBps } from '../src/utils/amounts.js';

// Read-only: never creates orders or sends funds. Prices are indicative catalogue
// USD marks, not a guaranteed executable market benchmark.
const client = new ChangeNowClient({ changeNowApiKey: process.env.CHANGENOW_API_KEY });
if (!client.enabled) throw new Error('Set CHANGENOW_API_KEY in the ignored .env first.');
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
  const match = destination && matchChangeNowAsset(destination, currencies, 'buy');
  if (!match) continue;
  for (const fromAmount of ['1', '10', '100']) {
    try {
      const estimate = await client.request('exchange/estimated-amount', { query: {
        fromCurrency: 'ltc', fromNetwork: 'ltc', toCurrency: match.ticker, toNetwork: match.network,
        fromAmount, flow: 'standard', type: 'direct',
      } });
      const bps = quotedRouteCostBps({ amountInUsd: (Number(fromAmount) * Number(origin.price)).toFixed(8), amountOutUsd: (Number(estimate.toAmount) * Number(destination.price)).toFixed(8) });
      print(JSON.stringify({ checkedAt: new Date().toISOString(), fromLtc: fromAmount, toNetwork: match.network, toUsdt: estimate.toAmount, indicativeCostPercent: bps === null ? null : bps / 100, depositFeeLtc: estimate.depositFee, withdrawalFeeUsdt: estimate.withdrawalFee, forecastMinutes: estimate.transactionSpeedForecast }));
    } catch (error) { print(JSON.stringify({ fromLtc: fromAmount, toNetwork: match.network, errorCode: error.code ?? 'REQUEST_FAILED' })); }
  }
}

function print(value) { process.stdout.write(`${value}\n`); }
