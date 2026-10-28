import { timingSafeEqual } from 'node:crypto';
import { BlockCypherMonitor } from './blockcypher-monitor.js';
import { EvmPendingMonitor } from './evm-pending-monitor.js';
import { SolanaMonitor } from './helius-monitor.js';
import {
  amountMatchesRange,
  blockCypherOutputAmount,
  detectedPayoutStatus,
  isUnconfirmedBlockCypherTransaction,
  payoutAmountRange,
  payoutExplorerUrl,
} from './payout-detection.js';

const ACTIVE_STATUSES = new Set(['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING']);
const SWAP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export class PayoutMonitor {
  constructor({
    repositories,
    ticketService,
    catalogue,
    config,
    logger,
    fetchImpl = globalThis.fetch,
    webSocketFactory,
  }) {
    this.repositories = repositories;
    this.ticketService = ticketService;
    this.catalogue = catalogue;
    this.config = config;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.flushing = false;
    const onDetection = (swapId, detection) => this.recordDetection(swapId, detection);
    this.blockCypher = new BlockCypherMonitor({ repositories, config, logger, fetchImpl });
    this.solana = new SolanaMonitor({
      config,
      logger,
      onDetection,
      fetchImpl,
      ...(webSocketFactory ? { webSocketFactory } : {}),
    });
    this.evm = new EvmPendingMonitor({ config, logger, onDetection, fetchImpl });
  }

  start() {
    if (this.timer) return;
    this.logger.info({
      blockCypher: this.blockCypher.enabled,
      solana: this.solana.enabled,
      evmChains: Object.entries(this.config.evmPayoutRpcUrls)
        .filter(([, rpcUrl]) => Boolean(rpcUrl))
        .map(([blockchain]) => blockchain),
    }, 'Payout monitors initialized');
    void this.run();
    this.timer = setInterval(() => void this.run(), this.config.payoutMonitorIntervalMs);
    this.timer.unref?.();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.repositories.listPayoutMonitorCandidates();
      const entries = candidates
        .filter((swap) => !['changenow', 'changelly', 'fixedfloat'].includes(swap.executable_quote?.provider))
        .map((swap) => ({ swap, asset: this.catalogue.getAsset(swap.destination_asset_id) }))
        .filter(({ asset }) => asset);
      const activeIds = new Set(entries.map(({ swap }) => swap.id));

      for (const { swap, asset } of entries) {
        if (this.blockCypher.supports(asset.blockchain)) {
          await this.blockCypher.ensureRegistration({ ...swap, destination_blockchain: asset.blockchain });
        }
      }

      await this.solana.reconcile(entries.filter(({ asset }) => this.solana.supports(asset.blockchain)));
      await mapWithConcurrency(
        entries.filter(({ asset }) => this.evm.supports(asset.blockchain)),
        4,
        ({ swap, asset }) => this.evm.poll(swap, asset),
      );
      this.evm.forget(activeIds);

      const staleRegistrations = await this.repositories.listPayoutMonitorRegistrationsToRemove();
      for (const swap of staleRegistrations) {
        const asset = this.catalogue.getAsset(swap.destination_asset_id);
        if (asset && this.blockCypher.supports(asset.blockchain)) {
          await this.blockCypher.removeRegistration({ ...swap, destination_blockchain: asset.blockchain });
        }
      }
      await this.flushNotifications();
    } catch (error) {
      this.logger.warn({ errorName: error.name, errorCode: 'PAYOUT_MONITOR_RUN_FAILED' }, 'Payout monitor cycle failed');
    } finally {
      this.running = false;
    }
  }

  async recordDetection(swapId, detection) {
    const recorded = await this.repositories.recordPayoutDetection(swapId, detection);
    if (!recorded) return false;
    const asset = this.catalogue.getAsset(recorded.destination_asset_id);
    this.logger.info({
      swapId,
      blockchain: asset?.blockchain,
      provider: detection.provider,
    }, 'Unconfirmed destination payout detected');
    void this.flushNotifications();
    return true;
  }

  async flushNotifications() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const swaps = await this.repositories.listDetectedPayoutsWithoutMessage();
      for (const swap of swaps) {
        await this.ticketService.notifyPayoutSent(swap, detectedPayoutStatus(swap));
      }
    } catch (error) {
      this.logger.warn({ errorName: error.name, errorCode: 'PAYOUT_NOTIFICATION_FLUSH_FAILED' }, 'Could not flush payout notifications');
    } finally {
      this.flushing = false;
    }
  }

  async handleWebhook(request, response) {
    if (!this.blockCypher.enabled || request.method !== 'POST') return false;
    const match = /^\/webhooks\/blockcypher\/([^/]+)\/([^/?]+)$/.exec(request.url ?? '');
    if (!match) return false;
    if (!safeEqual(match[1], this.config.payoutWebhookSecret) || !SWAP_ID_PATTERN.test(match[2])) {
      respond(response, 404, { error: 'not_found' });
      return true;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(request));
    } catch (error) {
      respond(response, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { accepted: false });
      return true;
    }

    const swap = await this.repositories.getSwapForPayoutDetection(match[2]);
    const asset = swap && this.catalogue.getAsset(swap.destination_asset_id);
    if (
      !swap
      || ['changenow', 'changelly', 'fixedfloat'].includes(swap.executable_quote?.provider)
      || !asset
      || !ACTIVE_STATUSES.has(swap.status)
      || swap.ticket_state !== 'OPEN'
      || !this.blockCypher.supports(asset.blockchain)
      || !isUnconfirmedBlockCypherTransaction(payload)
    ) {
      respond(response, 200, { accepted: false });
      return true;
    }

    const outputAmount = blockCypherOutputAmount(payload, swap.recipient);
    const range = payoutAmountRange(swap);
    if (!amountMatchesRange(outputAmount, range)) {
      respond(response, 200, { accepted: false });
      return true;
    }

    await this.recordDetection(swap.id, {
      provider: 'blockcypher',
      txHash: payload.hash,
      explorerUrl: payoutExplorerUrl(asset.blockchain, payload.hash),
    });
    respond(response, 200, { accepted: true });
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.solana.stop();
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_WEBHOOK_BODY_BYTES) {
      const error = new Error('Webhook body is too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''));
  const rightBuffer = Buffer.from(String(right ?? ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function respond(response, status, body) {
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

async function mapWithConcurrency(values, concurrency, operation) {
  const remaining = [...values];
  const workers = Array.from({ length: Math.min(concurrency, remaining.length) }, async () => {
    while (remaining.length > 0) await operation(remaining.shift());
  });
  await Promise.all(workers);
}
