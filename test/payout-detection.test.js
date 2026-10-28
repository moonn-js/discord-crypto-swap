import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EvmPendingMonitor } from '../src/services/evm-pending-monitor.js';
import { associatedTokenAddress, SolanaMonitor } from '../src/services/helius-monitor.js';
import {
  blockCypherOutputAmount,
  detectedPayoutStatus,
  evmBalanceOfData,
  payoutAmountRange,
} from '../src/services/payout-detection.js';
import { PayoutMonitor } from '../src/services/payout-monitor.js';

const swapId = '123e4567-e89b-42d3-a456-426614174000';

describe('pre-confirmation payout detection', () => {
  it('uses finalized output exactly and a narrow signed-quote range otherwise', () => {
    expect(payoutAmountRange({
      last_status_response: { swapDetails: { amountOut: '995' } },
      executable_quote: { quote: { amountOut: '1000', minAmountOut: '990' } },
    })).toEqual({ minimum: 995n, maximum: 995n });
    expect(payoutAmountRange({
      executable_quote: { quote: { amountOut: '1000', minAmountOut: '990' } },
    })).toEqual({ minimum: 990n, maximum: 1020n });
  });

  it('sums only UTXO outputs sent to the receiving address', () => {
    expect(blockCypherOutputAmount({
      outputs: [
        { addresses: ['ltc1destination'], value: 600 },
        { addresses: ['LTC1DESTINATION'], value: '400' },
        { addresses: ['ltc1change'], value: 25 },
      ],
    }, 'ltc1destination')).toBe(1000n);
  });

  it('builds standard ERC-20 balanceOf calldata', () => {
    const recipient = `0x${'ab'.repeat(20)}`;
    expect(evmBalanceOfData(recipient)).toBe(`0x70a08231000000000000000000000000${'ab'.repeat(20)}`);
  });

  it('derives the standard Solana associated token account', async () => {
    await expect(associatedTokenAddress(
      '9fYLFVoVqwH37C3dyPi6cpeobfbQ2jtLpN5HgAYDDdkm',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    )).resolves.toBe('5DMGH4bkaN4ZYBHrF7DVaNo3bkp5QagP1tfVUjPu7UAY');
  });

  it('enables native SOL and SPL monitoring with generic Solana RPC endpoints', () => {
    const monitor = new SolanaMonitor({
      config: {
        solanaPayoutRpcUrl: 'https://solana.example',
        solanaPayoutWebSocketUrl: 'wss://solana.example',
      },
      logger: { warn: vi.fn() },
      onDetection: vi.fn(),
    });
    expect(monitor.supports('sol')).toBe(true);
    expect(monitor.supports('eth')).toBe(false);
  });

  it('detects a matching EVM pending balance without treating it as final', async () => {
    const onDetection = vi.fn().mockResolvedValue(true);
    const monitor = new EvmPendingMonitor({
      config: { evmPayoutRpcUrls: { eth: 'https://rpc.example' } },
      logger: { warn: vi.fn() },
      onDetection,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { jsonrpc: '2.0', id: 1, result: '0x64' },
          { jsonrpc: '2.0', id: 2, result: '0x44c' },
        ],
      }),
    });
    const swap = {
      id: swapId,
      recipient: `0x${'ab'.repeat(20)}`,
      executable_quote: { quote: { amountOut: '1000', minAmountOut: '990' } },
    };

    await expect(monitor.poll(swap, { blockchain: 'eth', contractAddress: null })).resolves.toBe(true);
    expect(onDetection).toHaveBeenCalledWith(swapId, { provider: 'evm_pending_eth' });
  });

  it('accepts a matching BlockCypher unconfirmed callback and persists its hash', async () => {
    const repositories = {
      getSwapForPayoutDetection: vi.fn().mockResolvedValue({
        id: swapId,
        status: 'PROCESSING',
        ticket_state: 'OPEN',
        destination_asset_id: 'ltc',
        recipient: 'ltc1destination',
        executable_quote: { quote: { amountOut: '1000', minAmountOut: '990' } },
      }),
      recordPayoutDetection: vi.fn().mockResolvedValue({ id: swapId, destination_asset_id: 'ltc' }),
      listDetectedPayoutsWithoutMessage: vi.fn().mockResolvedValue([]),
    };
    const config = payoutConfig();
    const monitor = new PayoutMonitor({
      repositories,
      ticketService: { notifyPayoutSent: vi.fn() },
      catalogue: { getAsset: () => ({ blockchain: 'ltc', symbol: 'LTC' }) },
      config,
      logger: { info: vi.fn(), warn: vi.fn() },
      fetchImpl: vi.fn(),
    });
    const request = Readable.from([Buffer.from(JSON.stringify({
      hash: 'a'.repeat(64),
      confirmations: 0,
      block_height: -1,
      outputs: [{ addresses: ['ltc1destination'], value: 1000 }],
    }))]);
    request.method = 'POST';
    request.url = `/webhooks/blockcypher/${config.payoutWebhookSecret}/${swapId}`;
    const response = { writeHead: vi.fn(), end: vi.fn() };

    await expect(monitor.handleWebhook(request, response)).resolves.toBe(true);
    expect(repositories.recordPayoutDetection).toHaveBeenCalledWith(swapId, expect.objectContaining({
      provider: 'blockcypher',
      txHash: 'a'.repeat(64),
    }));
    expect(response.writeHead).toHaveBeenCalledWith(200);
  });

  it('renders independently detected transactions through the existing payout message', () => {
    const response = detectedPayoutStatus({
      status: 'PROCESSING',
      payout_detected_at: '2026-08-11T12:00:00.000Z',
      payout_detected_tx_hash: 'a'.repeat(64),
      payout_detected_explorer_url: `https://mempool.space/tx/${'a'.repeat(64)}`,
      executable_quote: { quote: { amountOutFormatted: '1.25' } },
    });
    expect(response.status).toBe('PROCESSING');
    expect(response.swapDetails.amountOutFormatted).toBe('1.25');
    expect(response.swapDetails.destinationChainTxHashes[0].hash).toBe('a'.repeat(64));
  });
});

function payoutConfig() {
  return {
    blockCypherApiToken: 'blockcypher-token',
    payoutWebhookBaseUrl: 'https://bot.example',
    payoutWebhookSecret: 'abcdefghijklmnopqrstuvwxyz123456',
    heliusApiKey: null,
    evmPayoutRpcUrls: {},
    payoutMonitorIntervalMs: 2_000,
  };
}
