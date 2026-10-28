import { ChannelType } from 'discord.js';
import { statusUpdatePayload } from '../discord/views.js';

const SUPPORTED_STATUSES = new Set([
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
]);

export class StatusWorker {
  constructor({ repositories, oneClick, client, ticketService, catalogue, config, health, logger }) {
    this.repositories = repositories;
    this.oneClick = oneClick;
    this.client = client;
    this.ticketService = ticketService;
    this.catalogue = catalogue;
    this.config = config;
    this.health = health;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.timer = setInterval(() => {
      this.run().catch((error) => this.logger.error({ errorCode: this.oneClick.errorCode(error) }, 'Status worker iteration failed'));
    }, this.config.statusWorkerIntervalMs);
    this.timer.unref?.();
    void this.run();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const swaps = await this.repositories.listDueSwaps(new Date(), 50);
      for (let index = 0; index < swaps.length; index += this.config.statusConcurrency) {
        const batch = swaps.slice(index, index + this.config.statusConcurrency);
        await Promise.all(batch.map((swap) => this.refreshSwap(swap, { announce: true, rethrow: false })));
      }
    } finally {
      this.running = false;
    }
  }

  async refreshSwap(swap, { announce = true, rethrow = false } = {}) {
    const deadline = swap.quote_deadline ? new Date(swap.quote_deadline).getTime() : Date.now();
    const fundingExpired = !['changenow', 'changelly', 'fixedfloat', 'relay'].includes(swap.executable_quote?.provider) && swap.status === 'PENDING_DEPOSIT' && Date.now() > deadline;
    const trackingExpired = Date.now() > deadline + this.config.staleTrackingMs;
    if (fundingExpired || trackingExpired) {
      const stale = await this.repositories.markSwapTrackingStale(swap.id);
      if (stale) {
        const ticket = await this.repositories.getTicket(stale.ticket_id);
        if (ticket?.state === 'OPEN') {
          await this.repositories.updateTicketFlow(ticket.id, 'TERMINAL', ticket.state_data ?? {});
          await this.ticketService.renderProgress(ticket.id);
          const scheduled = await this.ticketService.scheduleTerminalDeletion(
            ticket.id,
            fundingExpired
              ? 'Funding deadline passed without a detected deposit'
              : 'Automatic tracking reached its configured time limit',
            'TRACKING_STALE',
          );
          await this.announceStatus(
            stale.ticket_id,
            { status: 'TRACKING_STALE', updatedAt: new Date().toISOString() },
            { enabled: announce, terminalTicket: scheduled, swap: stale },
          );
        }
      }
      return stale;
    }

    try {
      const response = await this.oneClick.getExecutionStatus(swap);
      if (!SUPPORTED_STATUSES.has(response.status)) throw new Error('1Click returned an unsupported status.');
      const terminal = this.oneClick.isTerminal(response.status);
      const result = await this.repositories.updateSwapStatus(
        swap.id,
        response.status,
        response,
        terminal ? null : new Date(Date.now() + pollDelay(response.status, swap.deposit_tx_hash)),
        terminal,
      );
      if (result.swap && swap.guild_id && !result.swap.guild_id) {
        result.swap = { ...result.swap, guild_id: swap.guild_id };
      }
      if (!['changenow', 'changelly', 'fixedfloat', 'relay'].includes(swap.executable_quote?.provider)) this.health.oneClickAuthentication = true;
      if (response.status === 'SUCCESS' && result.swap) {
        await this.ticketService.publishCompletionSummary(result.swap);
        await this.ticketService.notifyCompletionVouch?.(result.swap);
      }
      if (terminal) {
        const ticket = await this.repositories.getTicket(swap.ticket_id);
        if (ticket?.state === 'OPEN') {
          await this.repositories.updateTicketFlow(ticket.id, 'TERMINAL', ticket.state_data ?? {});
          await this.ticketService.renderProgress(ticket.id);
          const scheduled = await this.ticketService.scheduleTerminalDeletion(ticket.id, `Swap reached terminal status: ${response.status}`);
          const alreadyClosedAtBroadcast = scheduled?.closure_reason === 'PAYOUT_BROADCAST'
            && response.status === 'SUCCESS';
          if (result.changed && !alreadyClosedAtBroadcast) {
            await this.announceStatus(swap.ticket_id, response, {
              enabled: announce,
              terminalTicket: scheduled,
              swap: result.swap,
            });
          }
        }
      } else if (result.changed) {
        await this.announceStatus(swap.ticket_id, response, { enabled: announce, swap: result.swap });
      }
      if (!terminal && result.swap && !['changenow', 'changelly', 'fixedfloat', 'relay'].includes(swap.executable_quote?.provider) && hasDestinationTransaction(response)) {
        await this.ticketService.notifyPayoutSent(result.swap, response).catch((error) => {
          this.logger.warn({
            swapId: swap.id,
            errorName: error.name,
            errorCode: 'PAYOUT_SENT_NOTIFICATION_FAILED',
          }, 'Could not process payout notification; status tracking will continue');
        });
      }
      return result.swap;
    } catch (error) {
      if (error?.status === 401 && !['ChangeNowError', 'ChangellyError', 'FixedFloatError', 'RelayError'].includes(error?.name)) this.health.oneClickAuthentication = false;
      const attempts = Number(swap.poll_attempts ?? 0) + 1;
      const backoff = Math.min(300_000, 15_000 * 2 ** Math.min(attempts - 1, 5));
      await this.repositories.scheduleSwapRetry(
        swap.id,
        new Date(Date.now() + backoff + Math.floor(Math.random() * 2000)),
        this.oneClick.errorCode(error),
      );
      this.logger.warn({ swapId: swap.id, errorCode: this.oneClick.errorCode(error), retryInMs: backoff }, 'Swap status refresh failed');
      if (rethrow) throw error;
      return null;
    }
  }

  async announceStatus(ticketId, response, { enabled, terminalTicket = null, swap = null }) {
    const ticket = terminalTicket ?? await this.repositories.getTicket(ticketId);
    if (!ticket) return;
    await this.ticketService.renderProgress(ticketId);
    const terminal = ['SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE'].includes(response.status);
    const depositDetected = response.status === 'KNOWN_DEPOSIT_TX';
    const incompleteDeposit = response.status === 'INCOMPLETE_DEPOSIT';
    if (response.status === 'PENDING_DEPOSIT' || (!enabled && !terminal && !depositDetected && !incompleteDeposit) || ticket.state !== 'OPEN' || !ticket.channel_id) return;
    const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const unix = terminal && ticket.delete_at ? Math.floor(new Date(ticket.delete_at).getTime() / 1000) : null;
    const content = terminal && unix
      ? `<@${ticket.user_id}> This ticket will be deleted <t:${unix}:F> (<t:${unix}:R>) unless you close it first.`
      : incompleteDeposit
        ? response.provider === 'fixedfloat'
          ? `<@${ticket.user_id}> FixedFloat received an incomplete deposit. Review the exchange or refund options below.`
          : `<@${ticket.user_id}> Additional deposit funds are needed to continue your swap.`
        : undefined;
    const allowedMentions = terminal || incompleteDeposit ? { users: [ticket.user_id] } : { parse: [] };
    let currentSwap = swap;
    if (!currentSwap && response.status === 'INCOMPLETE_DEPOSIT' && typeof this.repositories.getSwapByTicket === 'function') {
      currentSwap = await this.repositories.getSwapByTicket(ticketId);
    }
    const originAsset = currentSwap ? this.catalogue?.getAsset(currentSwap.origin_asset_id) : null;
    await channel.send({
      content,
      ...statusUpdatePayload(ticket.id, response, { swap: currentSwap, originAsset }),
      allowedMentions,
    }).catch((error) => {
      this.logger.warn({ ticketId, errorCode: 'STATUS_ANNOUNCEMENT_FAILED' }, `Could not post status update: ${error.name}`);
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

function pollDelay(status, submittedTransactionId) {
  if (status === 'PENDING_DEPOSIT' && submittedTransactionId) return 5_000;
  return 10_000;
}

function hasDestinationTransaction(response) {
  return (response?.swapDetails?.destinationChainTxHashes ?? []).some(
    (transaction) => typeof transaction?.hash === 'string' && transaction.hash.trim().length > 0,
  );
}
