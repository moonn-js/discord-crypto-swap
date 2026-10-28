import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { LifecycleWorker } from '../src/jobs/lifecycle-worker.js';
import { StatusWorker } from '../src/jobs/status-worker.js';

describe('terminal swap lifecycle', () => {
  it.each(['SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE'])('pings only the owner for %s', async (status) => {
    const deleteAt = new Date(Date.now() + 5 * 60_000);
    const channel = { type: ChannelType.GuildText, send: vi.fn().mockResolvedValue(undefined) };
    const worker = new StatusWorker({
      repositories: {},
      oneClick: {},
      client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
      ticketService: { renderProgress: vi.fn().mockResolvedValue(undefined) },
      config: {}, health: {}, logger: { warn: vi.fn() },
    });

    await worker.announceStatus('ticket', { status }, {
      enabled: false,
      terminalTicket: {
        id: 'ticket', state: 'OPEN', channel_id: 'channel', user_id: 'owner', delete_at: deleteAt,
      },
    });

    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringMatching(/^<@owner> .*<t:\d+:F> \(<t:\d+:R>\)/),
      allowedMentions: { users: ['owner'] },
    }));
  });

  it('posts a deposit-detected message even when discovered by Check Status', async () => {
    const channel = { type: ChannelType.GuildText, send: vi.fn().mockResolvedValue(undefined) };
    const worker = new StatusWorker({
      repositories: {
        getTicket: vi.fn().mockResolvedValue({
          id: 'ticket', state: 'OPEN', channel_id: 'channel', user_id: 'owner',
        }),
      },
      oneClick: {},
      client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
      ticketService: { renderProgress: vi.fn().mockResolvedValue(undefined) },
      config: {}, health: {}, logger: { warn: vi.fn() },
    });

    await worker.announceStatus('ticket', { status: 'KNOWN_DEPOSIT_TX' }, { enabled: false });

    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      embeds: [expect.objectContaining({ data: expect.objectContaining({ title: 'Deposit detected' }) })],
      allowedMentions: { parse: [] },
    }));
  });

  it('does not post a redundant awaiting-deposit status message', async () => {
    const channel = { type: ChannelType.GuildText, send: vi.fn().mockResolvedValue(undefined) };
    const worker = new StatusWorker({
      repositories: {
        getTicket: vi.fn().mockResolvedValue({
          id: 'ticket', state: 'OPEN', channel_id: 'channel', user_id: 'owner',
        }),
      },
      oneClick: {},
      client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
      ticketService: { renderProgress: vi.fn().mockResolvedValue(undefined) },
      config: {}, health: {}, logger: { warn: vi.fn() },
    });

    await worker.announceStatus('ticket', { status: 'PENDING_DEPOSIT' }, { enabled: true });

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('posts the calculated remaining amount when Check Status discovers an incomplete deposit', async () => {
    const channel = { type: ChannelType.GuildText, send: vi.fn().mockResolvedValue(undefined) };
    const worker = new StatusWorker({
      repositories: {
        getTicket: vi.fn().mockResolvedValue({
          id: 'ticket', state: 'OPEN', channel_id: 'channel', user_id: 'owner',
        }),
      },
      oneClick: {},
      client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
      ticketService: { renderProgress: vi.fn().mockResolvedValue(undefined) },
      catalogue: { getAsset: vi.fn().mockReturnValue({ symbol: 'LTC', blockchain: 'ltc', decimals: 8 }) },
      config: {}, health: {}, logger: { warn: vi.fn() },
    });

    await worker.announceStatus('ticket', {
      status: 'INCOMPLETE_DEPOSIT',
      swapDetails: { depositedAmount: '75000000' },
    }, {
      enabled: false,
      swap: {
        origin_asset_id: 'ltc-asset',
        deposit_address: 'ltc-deposit-address',
        executable_quote: { quote: { amountIn: '100000000' } },
      },
    });

    const payload = channel.send.mock.calls[0][0];
    expect(payload.embeds[0].toJSON().fields).toContainEqual({
      name: 'Additional amount needed',
      value: '0.25 LTC (Litecoin)',
    });
    expect(payload.content).toBe('<@owner> Additional deposit funds are needed to continue your swap.');
    expect(payload.allowedMentions).toEqual({ users: ['owner'] });
    expect(payload.components[0].toJSON().components).toContainEqual(expect.objectContaining({
      custom_id: 't:ticket:show-incomplete-deposit',
      label: 'Copy details',
    }));
  });

  it('schedules an open ticket for closure when status reaches success', async () => {
    const terminalSwap = { id: 'swap', ticket_id: 'ticket', status: 'SUCCESS' };
    const deleteAt = new Date(Date.now() + 5 * 60_000);
    const channel = { type: ChannelType.GuildText, send: vi.fn().mockResolvedValue(undefined) };
    const repositories = {
      updateSwapStatus: vi.fn().mockResolvedValue({ changed: true, swap: terminalSwap }),
      getTicket: vi.fn().mockResolvedValue({ id: 'ticket', state: 'OPEN', state_data: {}, channel_id: 'channel', user_id: 'owner' }),
      updateTicketFlow: vi.fn().mockResolvedValue(undefined),
      scheduleSwapRetry: vi.fn(),
    };
    const ticketService = {
      publishCompletionSummary: vi.fn().mockResolvedValue(true),
      renderProgress: vi.fn().mockResolvedValue(undefined),
      scheduleTerminalDeletion: vi.fn().mockResolvedValue({
        id: 'ticket', state: 'OPEN', channel_id: 'channel', user_id: 'owner', delete_at: deleteAt,
      }),
    };
    const worker = new StatusWorker({
      repositories,
      oneClick: {
        getExecutionStatus: vi.fn().mockResolvedValue({ status: 'SUCCESS', updatedAt: new Date().toISOString() }),
        isTerminal: () => true,
        errorCode: () => 'ERROR',
      },
      client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
      ticketService,
      config: { staleTrackingMs: 60_000 },
      health: {},
      logger: { warn: vi.fn() },
    });

    await worker.refreshSwap({
      id: 'swap',
      ticket_id: 'ticket',
      quote_deadline: new Date(Date.now() + 60_000),
      poll_attempts: 0,
    }, { announce: false });

    expect(ticketService.publishCompletionSummary).toHaveBeenCalledWith(terminalSwap);
    expect(repositories.updateTicketFlow).toHaveBeenCalledWith('ticket', 'TERMINAL', {});
    expect(ticketService.scheduleTerminalDeletion).toHaveBeenCalledWith('ticket', 'Swap reached terminal status: SUCCESS');
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('<@owner>'),
      allowedMentions: { users: ['owner'] },
    }));
    expect(repositories.scheduleSwapRetry).not.toHaveBeenCalled();
  });

  it('does not post a second success closing message after BlockCypher already closed the ticket', async () => {
    const terminalSwap = { id: 'swap', ticket_id: 'ticket', status: 'SUCCESS' };
    const repositories = {
      updateSwapStatus: vi.fn().mockResolvedValue({ changed: true, swap: terminalSwap }),
      getTicket: vi.fn().mockResolvedValue({
        id: 'ticket', state: 'OPEN', state_data: {}, channel_id: 'channel', user_id: 'owner',
      }),
      updateTicketFlow: vi.fn().mockResolvedValue(undefined),
      scheduleSwapRetry: vi.fn(),
    };
    const ticketService = {
      publishCompletionSummary: vi.fn().mockResolvedValue(true),
      renderProgress: vi.fn().mockResolvedValue(undefined),
      scheduleTerminalDeletion: vi.fn().mockResolvedValue({
        id: 'ticket',
        state: 'OPEN',
        channel_id: 'channel',
        user_id: 'owner',
        closure_reason: 'PAYOUT_BROADCAST',
        delete_at: new Date(Date.now() + 60_000),
      }),
    };
    const worker = new StatusWorker({
      repositories,
      oneClick: {
        getExecutionStatus: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
        isTerminal: () => true,
        errorCode: () => 'ERROR',
      },
      client: {},
      ticketService,
      config: { staleTrackingMs: 60_000 },
      health: {},
      logger: { warn: vi.fn() },
    });
    worker.announceStatus = vi.fn().mockResolvedValue(undefined);

    await worker.refreshSwap({
      id: 'swap',
      ticket_id: 'ticket',
      quote_deadline: new Date(Date.now() + 60_000),
      poll_attempts: 0,
    });

    expect(ticketService.publishCompletionSummary).toHaveBeenCalledWith(terminalSwap);
    expect(worker.announceStatus).not.toHaveBeenCalled();
  });

  it('stops polling an unfunded swap when its funding deadline passes', async () => {
    const repositories = {
      markSwapTrackingStale: vi.fn().mockResolvedValue({ id: 'swap', ticket_id: 'ticket' }),
      getTicket: vi.fn().mockResolvedValue({ id: 'ticket', state: 'DELETED' }),
    };
    const oneClick = {
      getExecutionStatus: vi.fn(),
      errorCode: () => 'ERROR',
    };
    const worker = new StatusWorker({
      repositories,
      oneClick,
      client: {},
      ticketService: {},
      config: { staleTrackingMs: 24 * 60 * 60_000 },
      health: {},
      logger: { warn: vi.fn() },
    });

    await worker.refreshSwap({
      id: 'swap',
      ticket_id: 'ticket',
      status: 'PENDING_DEPOSIT',
      quote_deadline: new Date(Date.now() - 1_000),
    });

    expect(repositories.markSwapTrackingStale).toHaveBeenCalledWith('swap');
    expect(oneClick.getExecutionStatus).not.toHaveBeenCalled();
  });

  it('continues tracking detected funds after the funding deadline', async () => {
    const repositories = {
      updateSwapStatus: vi.fn().mockResolvedValue({ changed: false, swap: { id: 'swap' } }),
      scheduleSwapRetry: vi.fn(),
    };
    const oneClick = {
      getExecutionStatus: vi.fn().mockResolvedValue({ status: 'PROCESSING' }),
      isTerminal: () => false,
      errorCode: () => 'ERROR',
    };
    const worker = new StatusWorker({
      repositories,
      oneClick,
      client: {},
      ticketService: {},
      config: { staleTrackingMs: 24 * 60 * 60_000 },
      health: {},
      logger: { warn: vi.fn() },
    });

    await worker.refreshSwap({
      id: 'swap',
      ticket_id: 'ticket',
      status: 'KNOWN_DEPOSIT_TX',
      quote_deadline: new Date(Date.now() - 1_000),
      poll_attempts: 0,
    });

    expect(oneClick.getExecutionStatus).toHaveBeenCalledOnce();
    expect(repositories.updateSwapStatus).toHaveBeenCalled();
  });

  it('announces a destination payout hash before success without closing the ticket', async () => {
    const processingSwap = { id: 'swap', ticket_id: 'ticket', status: 'PROCESSING' };
    const response = {
      status: 'PROCESSING',
      swapDetails: {
        amountOutFormatted: '99.25',
        destinationChainTxHashes: [{ hash: 'destination-transaction-hash' }],
      },
    };
    const repositories = {
      updateSwapStatus: vi.fn().mockResolvedValue({ changed: true, swap: processingSwap }),
      getTicket: vi.fn().mockResolvedValue(null),
      scheduleSwapRetry: vi.fn(),
    };
    const ticketService = {
      notifyPayoutSent: vi.fn().mockResolvedValue(true),
      scheduleTerminalDeletion: vi.fn(),
    };
    const worker = new StatusWorker({
      repositories,
      oneClick: {
        getExecutionStatus: vi.fn().mockResolvedValue(response),
        isTerminal: () => false,
        errorCode: () => 'ERROR',
      },
      client: {},
      ticketService,
      config: { staleTrackingMs: 24 * 60 * 60_000 },
      health: {},
      logger: { warn: vi.fn() },
    });
    worker.announceStatus = vi.fn().mockResolvedValue(undefined);

    await worker.refreshSwap({
      id: 'swap',
      ticket_id: 'ticket',
      status: 'PROCESSING',
      quote_deadline: new Date(Date.now() + 60_000),
      poll_attempts: 0,
    });

    expect(ticketService.notifyPayoutSent).toHaveBeenCalledWith(processingSwap, response);
    expect(worker.announceStatus).toHaveBeenCalledWith('ticket', response, { enabled: true, swap: processingSwap });
    expect(worker.announceStatus.mock.invocationCallOrder[0])
      .toBeLessThan(ticketService.notifyPayoutSent.mock.invocationCallOrder[0]);
    expect(ticketService.scheduleTerminalDeletion).not.toHaveBeenCalled();
    expect(repositories.scheduleSwapRetry).not.toHaveBeenCalled();
  });

  it.each([
    ['while awaiting a deposit normally', null, 'PENDING_DEPOSIT', 10_000],
    ['while awaiting detection after a transaction ID is submitted', 'a'.repeat(64), 'PENDING_DEPOSIT', 5_000],
    ['after the submitted transaction is detected', 'a'.repeat(64), 'KNOWN_DEPOSIT_TX', 10_000],
  ])('schedules the next status poll %s', async (_scenario, depositTransactionId, responseStatus, expectedDelay) => {
    const now = Date.parse('2026-08-11T12:00:00.000Z');
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    const repositories = {
      updateSwapStatus: vi.fn().mockResolvedValue({ changed: false, swap: { id: 'swap' } }),
      scheduleSwapRetry: vi.fn(),
    };
    const oneClick = {
      getExecutionStatus: vi.fn().mockResolvedValue({ status: responseStatus }),
      isTerminal: () => false,
      errorCode: () => 'ERROR',
    };
    const worker = new StatusWorker({
      repositories,
      oneClick,
      client: {},
      ticketService: {},
      config: { staleTrackingMs: 24 * 60 * 60_000 },
      health: {},
      logger: { warn: vi.fn() },
    });

    try {
      await worker.refreshSwap({
        id: 'swap',
        ticket_id: 'ticket',
        status: 'PENDING_DEPOSIT',
        deposit_tx_hash: depositTransactionId,
        quote_deadline: new Date(now + 60_000),
        poll_attempts: 0,
      });
    } finally {
      dateNow.mockRestore();
    }

    expect(repositories.updateSwapStatus).toHaveBeenCalledWith(
      'swap',
      responseStatus,
      { status: responseStatus },
      new Date(now + expectedDelay),
      false,
    );
  });

  it('deletes a ticket channel after its scheduled delay', async () => {
    const channel = { type: ChannelType.GuildText, delete: vi.fn().mockResolvedValue(undefined) };
    const repositories = {
      claimInactiveDraftTickets: vi.fn().mockResolvedValue([]),
      claimInactiveTicketReminders: vi.fn().mockResolvedValue([]),
      listTicketsDueForDeletion: vi.fn().mockResolvedValue([{ id: 'ticket', channel_id: 'channel' }]),
      markTicketDeleted: vi.fn().mockResolvedValue(undefined),
      listPendingCompletionSummaries: vi.fn().mockResolvedValue([]),
      deleteExpiredRecords: vi.fn().mockResolvedValue(0),
    };
    const worker = new LifecycleWorker({
      repositories,
      client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
      ticketService: { archiveFinalTicketTranscript: vi.fn().mockResolvedValue(false) },
      config: {
        ticketInactivityMs: 30 * 60_000,
        ticketInactivityReminderMs: 5 * 60_000,
        terminalRetentionMs: 30 * 86_400_000,
        abandonedRetentionMs: 24 * 3_600_000,
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await worker.run();

    expect(channel.delete).toHaveBeenCalledWith('Private swap ticket retention elapsed');
    expect(repositories.markTicketDeleted).toHaveBeenCalledWith('ticket');
  });

  it('warns an inactive draft once with its exact closing time', async () => {
    const lastActivity = new Date(Date.now() - 5 * 60_000);
    const reminderClaim = new Date();
    const channel = { type: ChannelType.GuildText, send: vi.fn().mockResolvedValue(undefined) };
    const repositories = {
      claimInactiveDraftTickets: vi.fn().mockResolvedValue([]),
      claimInactiveTicketReminders: vi.fn().mockResolvedValue([{
        id: 'ticket', channel_id: 'channel', user_id: 'owner', last_activity_at: lastActivity,
        inactivity_reminder_claimed_at: reminderClaim,
      }]),
      completeInactivityReminder: vi.fn().mockResolvedValue(undefined),
      releaseInactivityReminder: vi.fn(),
      listTicketsDueForDeletion: vi.fn().mockResolvedValue([]),
      listPendingCompletionSummaries: vi.fn().mockResolvedValue([]),
      deleteExpiredRecords: vi.fn().mockResolvedValue(0),
    };
    const worker = lifecycleWorker({ repositories, channel });

    await worker.run();

    const expectedUnix = Math.floor((lastActivity.getTime() + 30 * 60_000) / 1000);
    expect(channel.send).toHaveBeenCalledWith({
      content: expect.stringContaining(`<t:${expectedUnix}:F> (<t:${expectedUnix}:R>)`),
      allowedMentions: { users: ['owner'] },
    });
    expect(repositories.releaseInactivityReminder).not.toHaveBeenCalled();
    expect(repositories.completeInactivityReminder).toHaveBeenCalledWith('ticket', reminderClaim);
  });

  it('does not send a reminder if a route watch was enabled after the reminder was claimed', async () => {
    const channel = { type: ChannelType.GuildText, send: vi.fn() };
    const claimedAt = new Date();
    const repositories = {
      getTicket: vi.fn().mockResolvedValue({
        id: 'ticket', route_watch_action: 'popular-ltc-usdt-bsc', route_watch_notified_at: null,
      }),
      releaseInactivityReminder: vi.fn().mockResolvedValue(undefined),
    };
    const worker = lifecycleWorker({ repositories, channel });

    await worker.sendInactivityReminder({
      id: 'ticket', channel_id: 'channel', user_id: 'owner', inactivity_reminder_claimed_at: claimedAt,
    });

    expect(channel.send).not.toHaveBeenCalled();
    expect(repositories.releaseInactivityReminder).toHaveBeenCalledWith('ticket', claimedAt);
  });

  it('checks watched popular routes without issuing an inactivity reminder', async () => {
    const watched = { id: 'ticket', route_watch_action: 'popular-ltc-usdt-bsc' };
    const repositories = {
      claimDueRouteWatches: vi.fn().mockResolvedValue([watched]),
      claimInactiveDraftTickets: vi.fn().mockResolvedValue([]),
      claimInactiveTicketReminders: vi.fn().mockResolvedValue([]),
      listTicketsDueForDeletion: vi.fn().mockResolvedValue([]),
      listPendingCompletionSummaries: vi.fn().mockResolvedValue([]),
      deleteExpiredRecords: vi.fn().mockResolvedValue(0),
    };
    const ticketService = {
      checkWatchedPopularRoute: vi.fn().mockResolvedValue(false),
    };
    const worker = lifecycleWorker({ repositories, channel: null, ticketService });

    await worker.run();

    expect(repositories.claimDueRouteWatches).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
      10,
    );
    expect(ticketService.checkWatchedPopularRoute).toHaveBeenCalledWith(watched);
    expect(repositories.claimInactiveTicketReminders).toHaveBeenCalledOnce();
  });

  it('immediately deletes a 30-minute inactive draft and DMs its owner', async () => {
    const inactive = { id: 'ticket', channel_id: 'channel', user_id: 'owner', closure_reason: 'INACTIVITY' };
    const channel = { type: ChannelType.GuildText, delete: vi.fn().mockResolvedValue(undefined) };
    const repositories = {
      claimInactiveDraftTickets: vi.fn().mockResolvedValue([inactive]),
      claimInactiveTicketReminders: vi.fn().mockResolvedValue([]),
      listTicketsDueForDeletion: vi.fn().mockResolvedValue([]),
      markTicketDeleted: vi.fn().mockResolvedValue(undefined),
      listPendingCompletionSummaries: vi.fn().mockResolvedValue([]),
      deleteExpiredRecords: vi.fn().mockResolvedValue(0),
    };
    const ticketService = {
      archiveFinalTicketTranscript: vi.fn(),
      notifyInactivityClosure: vi.fn().mockResolvedValue(undefined),
    };
    const worker = lifecycleWorker({ repositories, channel, ticketService });

    await worker.run();

    expect(channel.delete).toHaveBeenCalledOnce();
    expect(repositories.markTicketDeleted).toHaveBeenCalledWith('ticket');
    expect(ticketService.notifyInactivityClosure).toHaveBeenCalledWith(inactive);
    expect(ticketService.archiveFinalTicketTranscript).not.toHaveBeenCalled();
  });
});

function lifecycleWorker({ repositories, channel, ticketService = {} }) {
  return new LifecycleWorker({
    repositories,
    client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
    ticketService,
    config: {
      ticketInactivityMs: 30 * 60_000,
      ticketInactivityReminderMs: 5 * 60_000,
      terminalRetentionMs: 30 * 86_400_000,
      abandonedRetentionMs: 24 * 3_600_000,
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  });
}
