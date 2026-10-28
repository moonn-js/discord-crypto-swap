import { describe, expect, it, vi } from 'vitest';
import { Repositories } from '../src/db/repositories.js';

describe('guild configurations', () => {
  it('seeds environment configuration without overwriting an administrator setup', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const repositories = new Repositories(pool);

    await repositories.seedGuildConfigurations([{
      guildId: 'guild',
      panelChannelId: 'panel',
      ticketCategoryId: 'category',
      completedDealsChannelId: 'completed',
      transcriptChannelId: 'logs',
      vouchChannelId: null,
    }]);

    expect(pool.query.mock.calls[0][0]).toContain('ON CONFLICT (guild_id) DO NOTHING');
    expect(pool.query.mock.calls[0][1]).toEqual([
      'guild', 'panel', 'category', 'completed', 'logs', null,
    ]);
  });

  it('persists nullable optional destinations selected by the setup wizard', async () => {
    const saved = {
      guildId: 'guild', panelChannelId: 'panel', ticketCategoryId: 'category',
      completedDealsChannelId: null, transcriptChannelId: null, vouchChannelId: null,
    };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [saved] }) };
    const repositories = new Repositories(pool);

    await expect(repositories.upsertGuildConfiguration({
      ...saved,
      configuredByUserId: 'admin',
    })).resolves.toEqual(saved);

    expect(pool.query.mock.calls[0][0]).toContain('ON CONFLICT (guild_id) DO UPDATE');
    expect(pool.query.mock.calls[0][1]).toEqual([
      'guild', 'panel', 'category', null, null, null, 'admin',
    ]);
  });
});

describe('popular route watches', () => {
  it('persists the selected route and resets inactivity state', async () => {
    const watched = { id: 'ticket', route_watch_action: 'popular-ltc-usdt-bsc' };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [watched] }) };
    const repositories = new Repositories(pool);

    await expect(repositories.enableRouteWatch('ticket', 'popular-ltc-usdt-bsc')).resolves.toEqual(watched);

    expect(pool.query.mock.calls[0][0]).toContain('route_watch_action = $2');
    expect(pool.query.mock.calls[0][0]).toContain('inactivity_reminder_sent_at = NULL');
    expect(pool.query.mock.calls[0][1]).toEqual(['ticket', 'popular-ltc-usdt-bsc']);
  });

  it('leases due watches and excludes active watches from inactivity reminders and closure', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const repositories = new Repositories(pool);
    const now = new Date();

    await repositories.claimDueRouteWatches(now, now, 10);
    await repositories.claimInactiveDraftTickets(now);
    await repositories.claimInactiveTicketReminders(now, now, now);

    expect(pool.query.mock.calls[0][0]).toContain('route_watch_claimed_at = NOW()');
    expect(pool.query.mock.calls[1][0]).toContain(
      'NOT (t.route_watch_action IS NOT NULL AND t.route_watch_notified_at IS NULL)',
    );
    expect(pool.query.mock.calls[2][0]).toContain(
      'NOT (t.route_watch_action IS NOT NULL AND t.route_watch_notified_at IS NULL)',
    );
  });

  it('cancels a watch when the ticket advances to another step', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'ticket' }] }) };
    const repositories = new Repositories(pool);

    await repositories.updateTicketFlowIfStep('ticket', 'ORIGIN_COIN', 'USD_AMOUNT', {});

    expect(pool.query.mock.calls[0][0]).toContain('route_watch_action = NULL');
    expect(pool.query.mock.calls[0][0]).toContain('route_watch_claimed_at = NULL');
  });
});

describe('ticket reservations', () => {
  it('uses a per-user lock and a three-ticket capacity check', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'ticket', step: 'ORIGIN_COIN' }] }),
    };
    const repositories = new Repositories(pool);

    const result = await repositories.reserveTicket({ id: 'ticket', guildId: 'guild', userId: 'user' });

    expect(result.created).toBe(true);
    expect(pool.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(pool.query.mock.calls[0][0]).toContain('COUNT(*)');
    expect(pool.query.mock.calls[0][1]).toEqual(['ticket', 'guild', 'user', '{}', 3]);
  });

  it('returns all active tickets when the capacity is full', async () => {
    const tickets = [{ id: 'three' }, { id: 'two' }, { id: 'one' }];
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rows: tickets }),
    };
    const repositories = new Repositories(pool);

    const result = await repositories.reserveTicket({ id: 'four', guildId: 'guild', userId: 'user' });

    expect(result).toMatchObject({ created: false, ticket: tickets[0], tickets, activeCount: 3 });
  });
});

describe('swap repository deadlines', () => {
  it('stores the verified request deadline instead of the provider address lifetime', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'swap' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    const repositories = new Repositories({ connect: vi.fn().mockResolvedValue(client) });
    const quoteResponse = {
      quoteRequest: { deadline: '2026-08-09T03:00:00.000Z' },
      quote: {
        depositAddress: 'deposit',
        deadline: '2026-08-12T00:00:00.000Z',
      },
    };

    await repositories.activateSwap('ticket', quoteResponse, new Date('2026-08-09T00:00:10.000Z'));

    expect(client.query.mock.calls[1][1][4]).toBe('2026-08-09T03:00:00.000Z');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('completed summary reconciliation', () => {
  it('loads every posted completed summary without a batch limit', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'oldest' }, { id: 'newest' }] }) };
    const repositories = new Repositories(pool);

    await expect(repositories.listPostedCompletionSummaries()).resolves.toHaveLength(2);

    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query.mock.calls[0][0]).not.toContain('LIMIT');
    expect(pool.query.mock.calls[0]).toHaveLength(1);
  });
});

describe('completion vouch claims', () => {
  it('allows a vouch DM after an independently detected payout message is saved', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'swap' }] }) };
    const repositories = new Repositories(pool);

    await expect(repositories.claimCompletionVouchDm('swap', new Date())).resolves.toEqual({ id: 'swap' });
    await repositories.listPendingCompletionVouchDms(new Date(), 25, ['guild']);

    expect(pool.query.mock.calls[0][0]).toContain(
      'payout_detected_at IS NOT NULL AND payout_sent_message_id IS NOT NULL',
    );
    expect(pool.query.mock.calls[1][0]).toContain(
      's.payout_detected_at IS NOT NULL AND s.payout_sent_message_id IS NOT NULL',
    );
  });
});

describe('user swap stats', () => {
  it('reads server totals only from this bot and guild', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{
          completed_swap_count: '7', total_amount_usd: '9000', fees_saved_usd: '90',
        }] }),
    };
    const repositories = new Repositories(pool);

    await expect(repositories.getUserSwapStats('current-guild', 'user')).resolves.toMatchObject({
      completed_swap_count: '7', total_amount_usd: '9000', fees_saved_usd: '90',
    });

    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query.mock.calls[0][0]).toContain('FROM user_swap_stats');
    expect(pool.query.mock.calls[0][0]).not.toContain('pg_catalog');
    expect(pool.query.mock.calls[0][0]).not.toContain('UNION ALL');
    expect(pool.query.mock.calls[0][0]).toContain('WHERE user_id = $1 AND guild_id = $2');
    expect(pool.query.mock.calls[0][1]).toEqual(['user', 'current-guild']);
  });

  it('orders the server leaderboard by total exchanged value', async () => {
    const rows = [{ user_id: 'top', total_amount_usd: '10000' }];
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows }),
    };
    const repositories = new Repositories(pool);

    await expect(repositories.listUserSwapLeaderboard('current-guild', 5)).resolves.toEqual(rows);

    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query.mock.calls[0][0]).toContain('FROM user_swap_stats');
    expect(pool.query.mock.calls[0][0]).not.toContain('pg_catalog');
    expect(pool.query.mock.calls[0][0]).not.toContain('UNION ALL');
    expect(pool.query.mock.calls[0][0]).toContain('WHERE guild_id = $1');
    expect(pool.query.mock.calls[0][0]).toContain('ORDER BY SUM(total_amount_usd) DESC');
    expect(pool.query.mock.calls[0][1]).toEqual(['current-guild', 5]);
  });
});

describe('swap status changes', () => {
  it('records successful volume atomically and returns the updated lifetime totals', async () => {
    const completedSwap = {
      id: 'swap',
      status: 'SUCCESS',
      executable_quote: { quote: { amountInUsd: '2500.25' } },
    };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'PROCESSING', last_status_response: {} }] })
        .mockResolvedValueOnce({ rows: [completedSwap] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ guild_id: 'guild', user_id: 'user', applied_count: 1 }] })
        .mockResolvedValueOnce({ rows: [{
          completed_swap_count: '3',
          total_amount_usd: '5000.25',
          fees_saved_usd: '50.0025',
        }] })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    const repositories = new Repositories({ connect: vi.fn().mockResolvedValue(client) });

    const result = await repositories.updateSwapStatus(
      'swap',
      'SUCCESS',
      { status: 'SUCCESS' },
      null,
      true,
    );

    expect(result.userStats).toEqual({
      completed_swap_count: '3',
      total_amount_usd: '5000.25',
      fees_saved_usd: '50.0025',
    });
    const statsQuery = client.query.mock.calls[4];
    expect(statsQuery[0]).toContain('stats_recorded_at IS NULL');
    expect(statsQuery[0]).toContain('INSERT INTO user_swap_stats');
    expect(statsQuery[0]).toContain('user_swap_stats.completed_swap_count + 1');
    expect(statsQuery[1]).toEqual(['swap', '2500.25']);
    expect(client.query.mock.calls[5][0]).toContain('FROM user_swap_stats');
    expect(client.query.mock.calls[5][1]).toEqual(['user', 'guild']);
    expect(client.query.mock.calls.at(-1)[0]).toBe('COMMIT');
  });

  it('treats a new cumulative incomplete-deposit amount as an announceable change', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            status: 'INCOMPLETE_DEPOSIT',
            last_status_response: { swapDetails: { depositedAmount: '50000000' } },
          }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'swap', status: 'INCOMPLETE_DEPOSIT' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    const repositories = new Repositories({ connect: vi.fn().mockResolvedValue(client) });
    const response = { status: 'INCOMPLETE_DEPOSIT', swapDetails: { depositedAmount: '75000000' } };

    const result = await repositories.updateSwapStatus('swap', 'INCOMPLETE_DEPOSIT', response, new Date(), false);

    expect(result.changed).toBe(true);
    expect(client.query.mock.calls.some(([query]) => String(query).includes('INSERT INTO swap_status_events'))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('does not reannounce an unchanged cumulative incomplete deposit', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            status: 'INCOMPLETE_DEPOSIT',
            last_status_response: { swapDetails: { depositedAmount: '075000000' } },
          }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'swap', status: 'INCOMPLETE_DEPOSIT' }] })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    const repositories = new Repositories({ connect: vi.fn().mockResolvedValue(client) });
    const response = { status: 'INCOMPLETE_DEPOSIT', swapDetails: { depositedAmount: '75000000' } };

    const result = await repositories.updateSwapStatus('swap', 'INCOMPLETE_DEPOSIT', response, new Date(), false);

    expect(result.changed).toBe(false);
    expect(client.query.mock.calls.some(([query]) => String(query).includes('INSERT INTO swap_status_events'))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
