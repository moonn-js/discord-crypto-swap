import { completedSwapAmountUsd } from '../utils/amounts.js';

export class Repositories {
  constructor(pool) {
    this.pool = pool;
  }

  async seedGuildConfigurations(guildConfigurations) {
    for (const guild of guildConfigurations) {
      await this.pool.query(
        `INSERT INTO guild_configurations
           (guild_id, panel_channel_id, ticket_category_id, completed_deals_channel_id,
            transcript_channel_id, vouch_channel_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (guild_id) DO NOTHING`,
        [
          guild.guildId,
          guild.panelChannelId,
          guild.ticketCategoryId,
          guild.completedDealsChannelId ?? null,
          guild.transcriptChannelId ?? null,
          guild.vouchChannelId ?? null,
        ],
      );
    }
  }

  async listGuildConfigurations() {
    const result = await this.pool.query(
      `SELECT guild_id AS "guildId",
              panel_channel_id AS "panelChannelId",
              ticket_category_id AS "ticketCategoryId",
              completed_deals_channel_id AS "completedDealsChannelId",
              transcript_channel_id AS "transcriptChannelId",
              vouch_channel_id AS "vouchChannelId",
              configured_by_user_id AS "configuredByUserId",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
       FROM guild_configurations
       ORDER BY created_at, guild_id`,
    );
    return result.rows;
  }

  async getGuildConfiguration(guildId) {
    const result = await this.pool.query(
      `SELECT guild_id AS "guildId",
              panel_channel_id AS "panelChannelId",
              ticket_category_id AS "ticketCategoryId",
              completed_deals_channel_id AS "completedDealsChannelId",
              transcript_channel_id AS "transcriptChannelId",
              vouch_channel_id AS "vouchChannelId",
              configured_by_user_id AS "configuredByUserId",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
       FROM guild_configurations
       WHERE guild_id = $1`,
      [guildId],
    );
    return result.rows[0] ?? null;
  }

  async upsertGuildConfiguration(configuration) {
    const result = await this.pool.query(
      `INSERT INTO guild_configurations
         (guild_id, panel_channel_id, ticket_category_id, completed_deals_channel_id,
          transcript_channel_id, vouch_channel_id, configured_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (guild_id) DO UPDATE
       SET panel_channel_id = EXCLUDED.panel_channel_id,
           ticket_category_id = EXCLUDED.ticket_category_id,
           completed_deals_channel_id = EXCLUDED.completed_deals_channel_id,
           transcript_channel_id = EXCLUDED.transcript_channel_id,
           vouch_channel_id = EXCLUDED.vouch_channel_id,
           configured_by_user_id = EXCLUDED.configured_by_user_id,
           updated_at = NOW()
       RETURNING guild_id AS "guildId",
                 panel_channel_id AS "panelChannelId",
                 ticket_category_id AS "ticketCategoryId",
                 completed_deals_channel_id AS "completedDealsChannelId",
                 transcript_channel_id AS "transcriptChannelId",
                 vouch_channel_id AS "vouchChannelId",
                 configured_by_user_id AS "configuredByUserId",
                 created_at AS "createdAt",
                 updated_at AS "updatedAt"`,
      [
        configuration.guildId,
        configuration.panelChannelId,
        configuration.ticketCategoryId,
        configuration.completedDealsChannelId ?? null,
        configuration.transcriptChannelId ?? null,
        configuration.vouchChannelId ?? null,
        configuration.configuredByUserId ?? null,
      ],
    );
    return result.rows[0];
  }

  async getPanel(guildId) {
    const result = await this.pool.query('SELECT * FROM bot_panels WHERE guild_id = $1', [guildId]);
    return result.rows[0] ?? null;
  }

  async savePanel(guildId, channelId, messageId) {
    const result = await this.pool.query(
      `INSERT INTO bot_panels (guild_id, channel_id, message_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id) DO UPDATE
       SET channel_id = EXCLUDED.channel_id,
           message_id = EXCLUDED.message_id,
           updated_at = NOW()
       RETURNING *`,
      [guildId, channelId, messageId],
    );
    return result.rows[0];
  }

  async replaceAssetCatalogue(assets) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE supported_assets SET active = FALSE, updated_at = NOW() WHERE active = TRUE');
      for (const asset of assets) {
        await client.query(
          `INSERT INTO supported_assets
             (asset_id, blockchain, symbol, decimals, contract_address, price, price_updated_at, active, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
           ON CONFLICT (asset_id) DO UPDATE
           SET blockchain = EXCLUDED.blockchain,
               symbol = EXCLUDED.symbol,
               decimals = EXCLUDED.decimals,
               contract_address = EXCLUDED.contract_address,
               price = EXCLUDED.price,
               price_updated_at = EXCLUDED.price_updated_at,
               active = TRUE,
               last_seen_at = NOW(),
               updated_at = NOW()`,
          [
            asset.assetId,
            asset.blockchain,
            asset.symbol,
            asset.decimals,
            asset.contractAddress ?? null,
            asset.price == null ? null : String(asset.price),
            asset.priceUpdatedAt ?? null,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listActiveAssets() {
    const result = await this.pool.query(
      `SELECT asset_id AS "assetId",
              blockchain,
              symbol,
              decimals,
              contract_address AS "contractAddress",
              price,
              price_updated_at AS "priceUpdatedAt"
       FROM supported_assets
       WHERE active = TRUE
       ORDER BY blockchain, symbol, asset_id`,
    );
    return result.rows;
  }

  async reserveTicket({ id, guildId, userId, stateData = {}, maxActiveTickets = 3 }) {
    if (!Number.isInteger(maxActiveTickets) || maxActiveTickets < 1 || maxActiveTickets > 10) {
      throw new TypeError('maxActiveTickets must be an integer from 1 to 10.');
    }
    const inserted = await this.pool.query(
      `WITH user_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($2 || ':' || $3, 0))
       )
       INSERT INTO tickets (id, guild_id, user_id, state, step, state_data)
       SELECT $1, $2, $3, 'CREATING', 'ORIGIN_COIN', $4::jsonb
       FROM user_lock
       WHERE (
         SELECT COUNT(*)
         FROM tickets
         WHERE guild_id = $2 AND user_id = $3 AND state <> 'DELETED'
       ) < $5
       RETURNING *`,
      [id, guildId, userId, JSON.stringify(stateData), maxActiveTickets],
    );

    if (inserted.rowCount > 0) return { created: true, ticket: inserted.rows[0] };

    const tickets = await this.getOpenTicketsForUser(guildId, userId);
    return {
      created: false,
      ticket: tickets[0] ?? null,
      tickets,
      activeCount: tickets.length,
    };
  }

  async completeTicketCreation(id, channelId) {
    const result = await this.pool.query(
      `UPDATE tickets
       SET channel_id = $2,
           state = 'OPEN',
           inactivity_reminder_claimed_at = NULL,
           inactivity_reminder_sent_at = NULL,
           updated_at = NOW(),
           last_activity_at = NOW()
       WHERE id = $1 AND state = 'CREATING'
       RETURNING *`,
      [id, channelId],
    );
    return result.rows[0] ?? null;
  }

  async failTicketCreation(id) {
    await this.pool.query(
      `UPDATE tickets
       SET state = 'DELETED', deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND state = 'CREATING'`,
      [id],
    );
  }

  async setProgressMessage(id, messageId) {
    await this.pool.query(
      `UPDATE tickets SET progress_message_id = $2, updated_at = NOW() WHERE id = $1`,
      [id, messageId],
    );
  }

  async setHeaderMessage(id, messageId) {
    await this.pool.query(
      `UPDATE tickets SET header_message_id = $2, updated_at = NOW() WHERE id = $1`,
      [id, messageId],
    );
  }

  async getTicket(id) {
    const result = await this.pool.query('SELECT * FROM tickets WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async getOpenTicketsForUser(guildId, userId) {
    const result = await this.pool.query(
      `SELECT * FROM tickets
       WHERE guild_id = $1 AND user_id = $2 AND state <> 'DELETED'
       ORDER BY created_at DESC`,
      [guildId, userId],
    );
    return result.rows;
  }

  async getUserChainAddress(guildId, userId, blockchain) {
    const result = await this.pool.query(
      `SELECT address
       FROM user_chain_addresses
       WHERE guild_id = $1 AND user_id = $2 AND blockchain = $3`,
      [guildId, userId, blockchain],
    );
    return result.rows[0]?.address ?? null;
  }

  async saveUserChainAddress(guildId, userId, blockchain, address) {
    const result = await this.pool.query(
      `INSERT INTO user_chain_addresses (guild_id, user_id, blockchain, address)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, user_id, blockchain) DO UPDATE
       SET address = EXCLUDED.address,
           updated_at = NOW()
       RETURNING address`,
      [guildId, userId, blockchain, address],
    );
    return result.rows[0]?.address ?? null;
  }

  async getOpenTicketByChannel(channelId) {
    const result = await this.pool.query(
      `SELECT * FROM tickets
       WHERE channel_id = $1 AND state = 'OPEN'
       LIMIT 1`,
      [channelId],
    );
    return result.rows[0] ?? null;
  }

  async listOpenTickets(limit = 100) {
    const result = await this.pool.query(
      `SELECT * FROM tickets
       WHERE state = 'OPEN'
       ORDER BY updated_at
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async updateTicketFlow(id, step, stateData) {
    const result = await this.pool.query(
      `UPDATE tickets
       SET step = $2,
           state_data = $3::jsonb,
           route_watch_action = NULL,
           route_watch_claimed_at = NULL,
           last_error_code = NULL,
           last_error_status = NULL,
           last_error_at = NULL,
           inactivity_reminder_claimed_at = NULL,
           inactivity_reminder_sent_at = NULL,
           updated_at = NOW(),
           last_activity_at = NOW()
       WHERE id = $1 AND state = 'OPEN'
       RETURNING *`,
      [id, step, JSON.stringify(stateData)],
    );
    return result.rows[0] ?? null;
  }

  async updateTicketFlowIfStep(id, expectedStep, nextStep, stateData) {
    const result = await this.pool.query(
      `UPDATE tickets
       SET step = $3,
           state_data = $4::jsonb,
           route_watch_action = NULL,
           route_watch_claimed_at = NULL,
           last_error_code = NULL,
           last_error_status = NULL,
           last_error_at = NULL,
           inactivity_reminder_claimed_at = NULL,
           inactivity_reminder_sent_at = NULL,
           updated_at = NOW(),
           last_activity_at = NOW()
       WHERE id = $1 AND state = 'OPEN' AND step = $2
       RETURNING *`,
      [id, expectedStep, nextStep, JSON.stringify(stateData)],
    );
    return result.rows[0] ?? null;
  }

  async touchTicket(id) {
    const result = await this.pool.query(
      `UPDATE tickets
       SET last_activity_at = NOW(),
           inactivity_reminder_claimed_at = NULL,
           inactivity_reminder_sent_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND state = 'OPEN'
       RETURNING *`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async enableRouteWatch(ticketId, routeAction) {
    const result = await this.pool.query(
      `UPDATE tickets
       SET route_watch_action = $2,
           route_watch_created_at = NOW(),
           route_watch_checked_at = NULL,
           route_watch_claimed_at = NULL,
           route_watch_notified_at = NULL,
           route_watch_notification_message_id = NULL,
           inactivity_reminder_claimed_at = NULL,
           inactivity_reminder_sent_at = NULL,
           last_activity_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND state = 'OPEN'
         AND (step = 'ORIGIN_COIN' OR ($2 = 'exact' AND step = 'USD_AMOUNT' AND state_data->>'noRouteOffer' IS NOT NULL))
       RETURNING *`,
      [ticketId, routeAction],
    );
    return result.rows[0] ?? null;
  }

  async claimDueRouteWatches(checkBefore, leaseBefore, limit = 10) {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT id
         FROM tickets
         WHERE state = 'OPEN'
           AND (step = 'ORIGIN_COIN' OR (route_watch_action = 'exact' AND step = 'USD_AMOUNT'))
           AND route_watch_action IS NOT NULL
           AND route_watch_notified_at IS NULL
           AND (route_watch_checked_at IS NULL OR route_watch_checked_at < $1)
           AND (route_watch_claimed_at IS NULL OR route_watch_claimed_at < $2)
         ORDER BY COALESCE(route_watch_checked_at, route_watch_created_at), route_watch_created_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE tickets t
       SET route_watch_claimed_at = NOW(), updated_at = NOW()
       FROM candidates
       WHERE t.id = candidates.id
       RETURNING t.*`,
      [checkBefore, leaseBefore, limit],
    );
    return result.rows;
  }

  async completeRouteWatchCheck(ticketId, claimedAt) {
    await this.pool.query(
      `UPDATE tickets
       SET route_watch_checked_at = NOW(),
           route_watch_claimed_at = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND route_watch_notified_at IS NULL
         AND route_watch_claimed_at = $2`,
      [ticketId, claimedAt],
    );
  }

  async completeRouteWatchNotification(ticketId, claimedAt, messageId) {
    const result = await this.pool.query(
      `UPDATE tickets
       SET route_watch_checked_at = NOW(),
           route_watch_claimed_at = NULL,
           route_watch_notified_at = NOW(),
           route_watch_notification_message_id = $3,
           inactivity_reminder_claimed_at = NULL,
           inactivity_reminder_sent_at = NULL,
           last_activity_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND state = 'OPEN'
         AND (step = 'ORIGIN_COIN' OR (route_watch_action = 'exact' AND step = 'USD_AMOUNT'))
         AND route_watch_notified_at IS NULL
         AND route_watch_claimed_at = $2
       RETURNING *`,
      [ticketId, claimedAt, messageId],
    );
    return result.rows[0] ?? null;
  }

  async cancelRouteWatch(ticketId) {
    await this.pool.query(
      `UPDATE tickets
       SET route_watch_action = NULL,
           route_watch_claimed_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [ticketId],
    );
  }

  async recordTicketError(id, errorCode, httpStatus = null) {
    await this.pool.query(
      `UPDATE tickets
       SET last_error_code = $2,
           last_error_status = $3,
           last_error_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [id, errorCode, httpStatus],
    );
  }

  async clearTicketError(id) {
    await this.pool.query(
      `UPDATE tickets
       SET last_error_code = NULL,
           last_error_status = NULL,
           last_error_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [id],
    );
  }

  async scheduleTicketClosure(id, deleteAt, closureReason = 'MANUAL') {
    const result = await this.pool.query(
      `UPDATE tickets
       SET state = 'CLOSING',
           step = 'CLOSING',
           locked_at = COALESCE(locked_at, NOW()),
           delete_at = COALESCE(delete_at, $2),
           closure_reason = COALESCE(closure_reason, $3),
           updated_at = NOW()
       WHERE id = $1 AND state IN ('CREATING', 'OPEN', 'CLOSING')
       RETURNING *`,
      [id, deleteAt, closureReason],
    );
    return result.rows[0] ?? null;
  }

  async scheduleTerminalTicketDeletion(id, deleteAt, closureReason = 'TERMINAL') {
    const result = await this.pool.query(
      `UPDATE tickets
       SET step = 'TERMINAL',
           delete_at = COALESCE(delete_at, $2),
           closure_reason = COALESCE(closure_reason, $3),
           updated_at = NOW()
       WHERE id = $1 AND state = 'OPEN'
       RETURNING *`,
      [id, deleteAt, closureReason],
    );
    return result.rows[0] ?? null;
  }

  async markTicketDeleted(id) {
    await this.pool.query(
      `UPDATE tickets
       SET state = 'DELETED', deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id],
    );
  }

  async claimInactiveDraftTickets(cutoff, limit = 25) {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT t.id
         FROM tickets t
         LEFT JOIN swaps s ON s.ticket_id = t.id
         WHERE t.state IN ('OPEN', 'CREATING')
           AND t.last_activity_at < $1
           AND NOT (t.route_watch_action IS NOT NULL AND t.route_watch_notified_at IS NULL)
           AND (s.id IS NULL OR s.executable_quote IS NULL)
         ORDER BY t.last_activity_at
         LIMIT $2
         FOR UPDATE OF t SKIP LOCKED
       )
       UPDATE tickets t
       SET state = 'CLOSING',
           step = 'CLOSING',
           locked_at = NOW(),
           delete_at = NOW(),
           closure_reason = 'INACTIVITY',
           updated_at = NOW()
       FROM candidates
       WHERE t.id = candidates.id
       RETURNING t.*`,
      [cutoff, limit],
    );
    return result.rows;
  }

  async claimInactiveTicketReminders(reminderCutoff, inactivityCutoff, leaseBefore, limit = 25) {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT t.id
         FROM tickets t
         LEFT JOIN swaps s ON s.ticket_id = t.id
         WHERE t.state IN ('OPEN', 'CREATING')
           AND t.last_activity_at < $1
           AND t.last_activity_at >= $2
           AND t.inactivity_reminder_sent_at IS NULL
           AND (t.inactivity_reminder_claimed_at IS NULL OR t.inactivity_reminder_claimed_at < $3)
           AND NOT (t.route_watch_action IS NOT NULL AND t.route_watch_notified_at IS NULL)
           AND (s.id IS NULL OR s.executable_quote IS NULL)
         ORDER BY t.last_activity_at
         LIMIT $4
         FOR UPDATE OF t SKIP LOCKED
       )
       UPDATE tickets t
       SET inactivity_reminder_claimed_at = NOW(), updated_at = NOW()
       FROM candidates
       WHERE t.id = candidates.id
       RETURNING t.*`,
      [reminderCutoff, inactivityCutoff, leaseBefore, limit],
    );
    return result.rows;
  }

  async completeInactivityReminder(ticketId, claimedAt) {
    await this.pool.query(
      `UPDATE tickets
       SET inactivity_reminder_claimed_at = NULL,
           inactivity_reminder_sent_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND inactivity_reminder_sent_at IS NULL
         AND inactivity_reminder_claimed_at = $2`,
      [ticketId, claimedAt],
    );
  }

  async releaseInactivityReminder(ticketId, claimedAt) {
    await this.pool.query(
      `UPDATE tickets
       SET inactivity_reminder_claimed_at = NULL, updated_at = NOW()
       WHERE id = $1 AND inactivity_reminder_claimed_at = $2`,
      [ticketId, claimedAt],
    );
  }

  async claimTicketTranscript(ticketId, leaseBefore) {
    const result = await this.pool.query(
      `UPDATE tickets t
       SET transcript_claimed_at = NOW(), updated_at = NOW()
       WHERE t.id = $1
         AND t.transcript_message_id IS NULL
         AND (t.transcript_claimed_at IS NULL OR t.transcript_claimed_at < $2)
         AND EXISTS (
           SELECT 1
           FROM swaps s
           WHERE s.ticket_id = t.id
             AND s.executable_quote IS NOT NULL
             AND s.status IN ('SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE')
         )
       RETURNING t.*`,
      [ticketId, leaseBefore],
    );
    return result.rows[0] ?? null;
  }

  async completeTicketTranscript(ticketId, messageId) {
    await this.pool.query(
      `UPDATE tickets
       SET transcript_message_id = $2,
           transcript_claimed_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND transcript_message_id IS NULL`,
      [ticketId, messageId],
    );
  }

  async releaseTicketTranscript(ticketId) {
    await this.pool.query(
      `UPDATE tickets
       SET transcript_claimed_at = NULL, updated_at = NOW()
       WHERE id = $1 AND transcript_message_id IS NULL`,
      [ticketId],
    );
  }

  async listTicketsDueForDeletion(now, limit = 25) {
    const result = await this.pool.query(
      `SELECT * FROM tickets
       WHERE delete_at <= $1
         AND (state = 'CLOSING' OR (state = 'OPEN' AND step = 'TERMINAL'))
       ORDER BY delete_at
       LIMIT $2`,
      [now, limit],
    );
    return result.rows;
  }

  async savePreview({
    id,
    ticketId,
    originAssetId,
    destinationAssetId,
    amountDisplay,
    amountBase,
    amountUsdRequested,
    conversionPriceUsd,
    conversionPriceAt,
    recipient,
    refundTo,
    slippageBps,
    dryQuote,
    previewExpiresAt,
  }) {
    const result = await this.pool.query(
      `INSERT INTO swaps
         (id, ticket_id, status, origin_asset_id, destination_asset_id,
          amount_display, amount_base, recipient, refund_to, slippage_bps,
          amount_usd_requested, conversion_price_usd, conversion_price_at,
          dry_quote, preview_expires_at)
       VALUES ($1, $2, 'PREVIEW', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
       ON CONFLICT (ticket_id) DO UPDATE
       SET status = 'PREVIEW',
           origin_asset_id = EXCLUDED.origin_asset_id,
           destination_asset_id = EXCLUDED.destination_asset_id,
           amount_display = EXCLUDED.amount_display,
           amount_base = EXCLUDED.amount_base,
           amount_usd_requested = EXCLUDED.amount_usd_requested,
           conversion_price_usd = EXCLUDED.conversion_price_usd,
           conversion_price_at = EXCLUDED.conversion_price_at,
           recipient = EXCLUDED.recipient,
           refund_to = EXCLUDED.refund_to,
           slippage_bps = EXCLUDED.slippage_bps,
           dry_quote = EXCLUDED.dry_quote,
           preview_expires_at = EXCLUDED.preview_expires_at,
           executable_quote = NULL,
           deposit_address = NULL,
           deposit_memo = NULL,
           quote_deadline = NULL,
           next_poll_at = NULL,
           poll_attempts = 0,
           last_error_code = NULL,
           updated_at = NOW()
       WHERE swaps.executable_quote IS NULL
       RETURNING *`,
      [
        id,
        ticketId,
        originAssetId,
        destinationAssetId,
        amountDisplay,
        amountBase,
        recipient,
        refundTo,
        slippageBps,
        amountUsdRequested,
        conversionPriceUsd,
        conversionPriceAt,
        JSON.stringify(dryQuote),
        previewExpiresAt,
      ],
    );
    return result.rows[0] ?? null;
  }

  async getSwapByTicket(ticketId) {
    const result = await this.pool.query('SELECT * FROM swaps WHERE ticket_id = $1', [ticketId]);
    return result.rows[0] ?? null;
  }

  async getSwapForPayoutDetection(swapId) {
    const result = await this.pool.query(
      `SELECT s.*,
              t.channel_id,
              t.user_id,
              t.state AS ticket_state
       FROM swaps s
       JOIN tickets t ON t.id = s.ticket_id
       WHERE s.id = $1`,
      [swapId],
    );
    return result.rows[0] ?? null;
  }

  async claimSwapConfirmation(ticketId) {
    const result = await this.pool.query(
      `UPDATE swaps
       SET status = 'CONFIRMING', updated_at = NOW()
       WHERE ticket_id = $1
         AND status = 'PREVIEW'
         AND preview_expires_at > NOW()
         AND executable_quote IS NULL
       RETURNING *`,
      [ticketId],
    );
    return result.rows[0] ?? null;
  }

  async revertSwapConfirmation(ticketId, errorCode) {
    await this.pool.query(
      `UPDATE swaps
       SET status = 'PREVIEW', last_error_code = $2, updated_at = NOW()
       WHERE ticket_id = $1 AND status = 'CONFIRMING' AND executable_quote IS NULL`,
      [ticketId, errorCode],
    );
  }

  async activateSwap(ticketId, quoteResponse, nextPollAt) {
    const quote = quoteResponse.quote;
    const fundingDeadline = quoteResponse.quoteRequest?.deadline;
    if (!fundingDeadline) throw new Error('The executable quote request deadline is unavailable.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE swaps
         SET status = 'PENDING_DEPOSIT',
             executable_quote = $2::jsonb,
             deposit_address = $3,
             deposit_memo = $4,
             quote_deadline = $5,
             next_poll_at = $6,
             poll_attempts = 0,
             last_error_code = NULL,
             updated_at = NOW()
         WHERE ticket_id = $1 AND status = 'CONFIRMING'
         RETURNING *`,
        [ticketId, JSON.stringify(quoteResponse), quote.depositAddress, quote.depositMemo ?? null, fundingDeadline, nextPollAt],
      );
      if (result.rowCount > 0) {
        await client.query(
          `INSERT INTO swap_status_events (swap_id, status, response)
           VALUES ($1, 'PENDING_DEPOSIT', $2::jsonb)`,
          [result.rows[0].id, JSON.stringify(quoteResponse)],
        );
      }
      await client.query('COMMIT');
      return result.rows[0] ?? null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveDepositTransactionHash(ticketId, txHash) {
    const result = await this.pool.query(
      `UPDATE swaps SET deposit_tx_hash = $2, updated_at = NOW()
       WHERE ticket_id = $1 AND executable_quote IS NOT NULL
       RETURNING *`,
      [ticketId, txHash],
    );
    return result.rows[0] ?? null;
  }

  async clearMissingQrMessage(swapId, staleMessageId) {
    await this.pool.query(
      `UPDATE swaps SET qr_message_id = NULL, updated_at = NOW()
       WHERE id = $1 AND qr_message_id = $2`,
      [swapId, staleMessageId],
    );
  }

  async claimQrMessage(swapId, messageId) {
    const result = await this.pool.query(
      `UPDATE swaps SET qr_message_id = $2, updated_at = NOW()
       WHERE id = $1 AND qr_message_id IS NULL
       RETURNING id`,
      [swapId, messageId],
    );
    return result.rowCount > 0;
  }

  async clearMissingDepositSpeedupMessage(swapId, staleMessageId) {
    await this.pool.query(
      `UPDATE swaps SET deposit_speedup_message_id = NULL, updated_at = NOW()
       WHERE id = $1 AND deposit_speedup_message_id = $2`,
      [swapId, staleMessageId],
    );
  }

  async claimDepositSpeedupMessage(swapId, messageId) {
    const result = await this.pool.query(
      `UPDATE swaps SET deposit_speedup_message_id = $2, updated_at = NOW()
       WHERE id = $1 AND deposit_speedup_message_id IS NULL
       RETURNING id`,
      [swapId, messageId],
    );
    return result.rowCount > 0;
  }

  async claimCompletionSummary(swapId, leaseBefore) {
    const result = await this.pool.query(
      `WITH claimed AS (
         UPDATE swaps
         SET completion_summary_claimed_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND status = 'SUCCESS'
           AND completion_summary_message_id IS NULL
           AND (completion_summary_claimed_at IS NULL OR completion_summary_claimed_at < $2)
         RETURNING *
       )
       SELECT claimed.*, tickets.user_id, tickets.guild_id
       FROM claimed
       LEFT JOIN tickets ON tickets.id = claimed.ticket_id`,
      [swapId, leaseBefore],
    );
    return result.rows[0] ?? null;
  }

  async completeCompletionSummary(swapId, messageId) {
    await this.pool.query(
      `UPDATE swaps
       SET completion_summary_message_id = $2,
           completion_summary_claimed_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND completion_summary_message_id IS NULL`,
      [swapId, messageId],
    );
  }

  async releaseCompletionSummary(swapId) {
    await this.pool.query(
      `UPDATE swaps
       SET completion_summary_claimed_at = NULL, updated_at = NOW()
       WHERE id = $1 AND completion_summary_message_id IS NULL`,
      [swapId],
    );
  }

  async claimCompletionVouchDm(swapId, leaseBefore) {
    const result = await this.pool.query(
      `WITH claimed AS (
         UPDATE swaps
         SET completion_vouch_dm_claimed_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND (
             status = 'SUCCESS'
             OR (payout_detected_at IS NOT NULL AND payout_sent_message_id IS NOT NULL)
           )
           AND executable_quote IS NOT NULL
           AND completion_vouch_dm_sent_at IS NULL
           AND completion_vouch_dm_failed_at IS NULL
           AND (completion_vouch_dm_claimed_at IS NULL OR completion_vouch_dm_claimed_at < $2)
         RETURNING *
       )
       SELECT claimed.*, tickets.user_id, tickets.guild_id
       FROM claimed
       JOIN tickets ON tickets.id = claimed.ticket_id`,
      [swapId, leaseBefore],
    );
    return result.rows[0] ?? null;
  }

  async completeCompletionVouchDm(swapId) {
    await this.pool.query(
      `UPDATE swaps
       SET completion_vouch_dm_sent_at = NOW(),
           completion_vouch_dm_claimed_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND completion_vouch_dm_sent_at IS NULL`,
      [swapId],
    );
  }

  async releaseCompletionVouchDm(swapId) {
    await this.pool.query(
      `UPDATE swaps
       SET completion_vouch_dm_claimed_at = NULL, updated_at = NOW()
       WHERE id = $1 AND completion_vouch_dm_sent_at IS NULL`,
      [swapId],
    );
  }

  async failCompletionVouchDm(swapId) {
    await this.pool.query(
      `UPDATE swaps
       SET completion_vouch_dm_failed_at = NOW(),
           completion_vouch_dm_claimed_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND completion_vouch_dm_sent_at IS NULL`,
      [swapId],
    );
  }

  async claimPayoutSentNotification(swapId, leaseBefore) {
    const result = await this.pool.query(
      `WITH claimed AS (
         UPDATE swaps
         SET payout_sent_notification_claimed_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND status NOT IN ('SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE')
           AND payout_sent_message_id IS NULL
           AND (
             payout_sent_notification_claimed_at IS NULL
             OR payout_sent_notification_claimed_at < $2
           )
         RETURNING *
       )
       SELECT claimed.*,
              tickets.user_id,
              tickets.guild_id,
              tickets.channel_id,
              tickets.state AS ticket_state
       FROM claimed
       JOIN tickets ON tickets.id = claimed.ticket_id`,
      [swapId, leaseBefore],
    );
    return result.rows[0] ?? null;
  }

  async completePayoutSentNotification(swapId, messageId) {
    await this.pool.query(
      `UPDATE swaps
       SET payout_sent_message_id = $2,
           payout_sent_notification_claimed_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND payout_sent_message_id IS NULL`,
      [swapId, messageId],
    );
  }

  async listPayoutMonitorCandidates(limit = 100) {
    const result = await this.pool.query(
      `SELECT s.*,
              t.channel_id,
              t.user_id,
              t.state AS ticket_state
       FROM swaps s
       JOIN tickets t ON t.id = s.ticket_id
       WHERE s.executable_quote IS NOT NULL
         AND s.status IN ('PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING')
         AND s.payout_sent_message_id IS NULL
         AND t.state = 'OPEN'
         AND t.channel_id IS NOT NULL
       ORDER BY s.updated_at
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async listPayoutMonitorRegistrationsToRemove(limit = 100) {
    const result = await this.pool.query(
      `SELECT s.*
       FROM swaps s
       JOIN tickets t ON t.id = s.ticket_id
       WHERE s.payout_monitor_id IS NOT NULL
         AND (
           s.status NOT IN ('PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING')
           OR s.payout_sent_message_id IS NOT NULL
           OR t.state <> 'OPEN'
           OR t.channel_id IS NULL
         )
       ORDER BY s.payout_monitor_created_at NULLS FIRST
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async savePayoutMonitorRegistration(swapId, provider, registrationId) {
    const result = await this.pool.query(
      `UPDATE swaps
       SET payout_monitor_provider = $2,
           payout_monitor_id = $3,
           payout_monitor_created_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND payout_monitor_id IS NULL
         AND payout_sent_message_id IS NULL
         AND status IN ('PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING')
       RETURNING *`,
      [swapId, provider, registrationId],
    );
    return result.rows[0] ?? null;
  }

  async clearPayoutMonitorRegistration(swapId, provider, registrationId) {
    const result = await this.pool.query(
      `UPDATE swaps
       SET payout_monitor_provider = NULL,
           payout_monitor_id = NULL,
           payout_monitor_created_at = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND payout_monitor_provider = $2
         AND payout_monitor_id = $3
       RETURNING id`,
      [swapId, provider, registrationId],
    );
    return result.rowCount > 0;
  }

  async recordPayoutDetection(swapId, { provider, txHash = null, explorerUrl = null }) {
    const result = await this.pool.query(
      `UPDATE swaps
       SET payout_detected_provider = $2,
           payout_detected_tx_hash = $3,
           payout_detected_explorer_url = $4,
           payout_detected_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND payout_detected_at IS NULL
         AND payout_sent_message_id IS NULL
         AND status NOT IN ('SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE')
       RETURNING *`,
      [swapId, provider, txHash, explorerUrl],
    );
    return result.rows[0] ?? null;
  }

  async listDetectedPayoutsWithoutMessage(limit = 25) {
    const result = await this.pool.query(
      `SELECT s.*,
              t.channel_id,
              t.user_id,
              t.state AS ticket_state
       FROM swaps s
       JOIN tickets t ON t.id = s.ticket_id
       WHERE s.payout_detected_at IS NOT NULL
         AND s.payout_sent_message_id IS NULL
         AND s.status NOT IN ('SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE')
         AND t.state = 'OPEN'
         AND t.channel_id IS NOT NULL
       ORDER BY s.payout_detected_at
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async listPendingCompletionSummaries(leaseBefore, limit = 25) {
    const result = await this.pool.query(
      `SELECT s.*, t.guild_id
       FROM swaps s
       JOIN tickets t ON t.id = s.ticket_id
       WHERE s.status = 'SUCCESS'
         AND s.executable_quote IS NOT NULL
         AND s.completion_summary_message_id IS NULL
         AND (s.completion_summary_claimed_at IS NULL OR s.completion_summary_claimed_at < $1)
       ORDER BY s.terminal_at NULLS LAST, s.updated_at
       LIMIT $2`,
      [leaseBefore, limit],
    );
    return result.rows;
  }

  async listPendingCompletionVouchDms(leaseBefore, limit = 25, guildIds = null) {
    const result = await this.pool.query(
      `SELECT s.*, t.guild_id
       FROM swaps s
       JOIN tickets t ON t.id = s.ticket_id
       WHERE (
           s.status = 'SUCCESS'
           OR (s.payout_detected_at IS NOT NULL AND s.payout_sent_message_id IS NOT NULL)
         )
         AND s.executable_quote IS NOT NULL
         AND s.completion_vouch_dm_sent_at IS NULL
         AND s.completion_vouch_dm_failed_at IS NULL
         AND (s.completion_vouch_dm_claimed_at IS NULL OR s.completion_vouch_dm_claimed_at < $1)
         AND ($3::text[] IS NULL OR t.guild_id = ANY($3::text[]))
       ORDER BY s.terminal_at NULLS LAST, s.updated_at
       LIMIT $2`,
      [leaseBefore, limit, guildIds],
    );
    return result.rows;
  }

  async listPostedCompletionSummaries() {
    const result = await this.pool.query(
      `SELECT s.*, t.guild_id
       FROM swaps s
       JOIN tickets t ON t.id = s.ticket_id
       WHERE s.status = 'SUCCESS'
         AND s.executable_quote IS NOT NULL
         AND s.completion_summary_message_id IS NOT NULL
       ORDER BY s.terminal_at DESC NULLS LAST, s.updated_at DESC`,
    );
    return result.rows;
  }

  async listDueSwaps(now, limit = 25) {
    const result = await this.pool.query(
      `SELECT s.*, t.channel_id, t.user_id, t.guild_id, t.state AS ticket_state
       FROM swaps s
       JOIN tickets t ON t.id = s.ticket_id
       WHERE s.next_poll_at IS NOT NULL
         AND s.next_poll_at <= $1
         AND s.executable_quote IS NOT NULL
         AND s.status NOT IN ('SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE')
       ORDER BY s.next_poll_at
       LIMIT $2`,
      [now, limit],
    );
    return result.rows;
  }

  async updateSwapStatus(swapId, status, response, nextPollAt, terminal) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT status, last_status_response FROM swaps WHERE id = $1 FOR UPDATE', [swapId]);
      if (current.rowCount === 0) {
        await client.query('ROLLBACK');
        return { changed: false, swap: null };
      }
      const previous = current.rows[0];
      const statusChanged = previous.status !== status;
      const depositedAmountChanged = status === 'INCOMPLETE_DEPOSIT'
        && previous.status === status
        && normalizedDepositedAmount(previous.last_status_response) !== normalizedDepositedAmount(response);
      const providerStatusChanged = ['changenow', 'changelly', 'fixedfloat'].includes(response?.provider)
        && previous.last_status_response?.providerStatus !== response.providerStatus;
      const changed = statusChanged || depositedAmountChanged || providerStatusChanged;
      const updated = await client.query(
        `UPDATE swaps
         SET status = $2,
             last_status_response = $3::jsonb,
             next_poll_at = $4,
             poll_attempts = 0,
             last_error_code = NULL,
             terminal_at = CASE WHEN $5 THEN COALESCE(terminal_at, NOW()) ELSE terminal_at END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [swapId, status, JSON.stringify(response), terminal ? null : nextPollAt, terminal],
      );
      if (changed) {
        await client.query(
          `INSERT INTO swap_status_events (swap_id, status, response)
           VALUES ($1, $2, $3::jsonb)`,
          [swapId, status, JSON.stringify(response)],
        );
      }
      const userStats = status === 'SUCCESS'
        ? await recordSuccessfulSwapStats(client, updated.rows[0])
        : null;
      await client.query('COMMIT');
      return { changed, swap: updated.rows[0], userStats };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getUserSwapStats(guildId, userId, { includeSwapId = null, includeAmountUsd = null } = {}) {
    const projectedAmountUsd = normalizePositiveDecimal(includeAmountUsd);
    const currentStats = await aggregateUserSwapStats(this.pool, guildId, userId);
    if (!projectedAmountUsd) return currentStats;

    const result = await this.pool.query(
      `WITH projected AS (
         SELECT CASE
                  WHEN $3::UUID IS NOT NULL
                   AND $4::NUMERIC IS NOT NULL
                   AND EXISTS (
                     SELECT 1
                     FROM swaps s
                     JOIN tickets t ON t.id = s.ticket_id
                     WHERE s.id = $3::UUID
                       AND s.stats_recorded_at IS NULL
                       AND t.guild_id = $1
                       AND t.user_id = $2
                   )
                  THEN 1
                  ELSE 0
                END::BIGINT AS completed_swap_count,
                CASE
                  WHEN $3::UUID IS NOT NULL
                   AND $4::NUMERIC IS NOT NULL
                   AND EXISTS (
                     SELECT 1
                     FROM swaps s
                     JOIN tickets t ON t.id = s.ticket_id
                     WHERE s.id = $3::UUID
                       AND s.stats_recorded_at IS NULL
                       AND t.guild_id = $1
                       AND t.user_id = $2
                   )
                  THEN $4::NUMERIC
                  ELSE 0
                END::NUMERIC AS total_amount_usd
       )
       SELECT ($5::BIGINT + projected.completed_swap_count)::TEXT AS completed_swap_count,
              ($6::NUMERIC + projected.total_amount_usd)::TEXT AS total_amount_usd,
              (($6::NUMERIC + projected.total_amount_usd) / 100)::TEXT AS fees_saved_usd
       FROM projected`,
      [
        guildId,
        userId,
        includeSwapId,
        projectedAmountUsd,
        currentStats.completed_swap_count,
        currentStats.total_amount_usd,
      ],
    );
    return result.rows[0] ?? currentStats;
  }

  async listUserSwapLeaderboard(guildId, limit = 5) {
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 25) : 5;
    return aggregateUserSwapLeaderboard(this.pool, guildId, normalizedLimit);
  }

  async scheduleSwapRetry(swapId, nextPollAt, errorCode) {
    await this.pool.query(
      `UPDATE swaps
       SET next_poll_at = $2,
           poll_attempts = poll_attempts + 1,
           last_error_code = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [swapId, nextPollAt, errorCode],
    );
  }

  async markSwapTrackingStale(swapId) {
    const result = await this.pool.query(
      `UPDATE swaps
       SET status = 'TRACKING_STALE',
           tracking_stale_at = NOW(),
           terminal_at = COALESCE(terminal_at, NOW()),
           next_poll_at = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND status NOT IN ('SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE')
       RETURNING *`,
      [swapId],
    );
    if (result.rowCount > 0) {
      await this.pool.query(
        `INSERT INTO swap_status_events (swap_id, status)
         VALUES ($1, 'TRACKING_STALE')`,
        [swapId],
      );
    }
    return result.rows[0] ?? null;
  }

  async deleteExpiredRecords(terminalBefore, abandonedBefore) {
    const result = await this.pool.query(
      `DELETE FROM tickets t
       WHERE t.state = 'DELETED'
         AND (
           EXISTS (
             SELECT 1 FROM swaps s
             WHERE s.ticket_id = t.id AND s.terminal_at IS NOT NULL AND s.terminal_at < $1
           )
           OR EXISTS (
             SELECT 1 FROM swaps s
             WHERE s.ticket_id = t.id
               AND s.status = 'TRACKING_STALE'
               AND s.tracking_stale_at < $2
           )
           OR (
             NOT EXISTS (SELECT 1 FROM swaps s WHERE s.ticket_id = t.id)
             AND t.updated_at < $2
           )
           OR EXISTS (
             SELECT 1 FROM swaps s
             WHERE s.ticket_id = t.id
               AND s.executable_quote IS NULL
               AND s.updated_at < $2
           )
         )`,
      [terminalBefore, abandonedBefore],
    );
    return result.rowCount;
  }
}

async function recordSuccessfulSwapStats(client, swap) {
  const amountUsd = completedSwapAmountUsd(swap);
  if (!amountUsd) return null;
  const result = await client.query(
    `WITH owner AS (
       SELECT t.guild_id, t.user_id
       FROM swaps s
       JOIN tickets t ON t.id = s.ticket_id
       WHERE s.id = $1
     ), claimed AS (
       UPDATE swaps
       SET stats_recorded_at = NOW()
       WHERE id = $1
         AND status = 'SUCCESS'
         AND stats_recorded_at IS NULL
       RETURNING id
     ), applied_local AS (
       INSERT INTO user_swap_stats (guild_id, user_id, completed_swap_count, total_amount_usd)
       SELECT owner.guild_id, owner.user_id, 1, $2::NUMERIC
       FROM owner
       CROSS JOIN claimed
       ON CONFLICT (guild_id, user_id) DO UPDATE
       SET completed_swap_count = user_swap_stats.completed_swap_count + 1,
           total_amount_usd = user_swap_stats.total_amount_usd + EXCLUDED.total_amount_usd,
           updated_at = NOW()
       RETURNING user_id
     )
     SELECT owner.guild_id,
            owner.user_id,
            (SELECT COUNT(*) FROM applied_local)::INTEGER AS applied_count
     FROM owner`,
    [swap.id, amountUsd],
  );
  const guildId = result.rows[0]?.guild_id;
  const userId = result.rows[0]?.user_id;
  return guildId && userId ? aggregateUserSwapStats(client, guildId, userId) : null;
}

async function aggregateUserSwapStats(queryable, guildId, userId) {
  const result = await queryable.query(
    `SELECT COALESCE(SUM(completed_swap_count), 0)::TEXT AS completed_swap_count,
            COALESCE(SUM(total_amount_usd), 0)::TEXT AS total_amount_usd,
            (COALESCE(SUM(total_amount_usd), 0) / 100)::TEXT AS fees_saved_usd
     FROM user_swap_stats
     WHERE user_id = $1 AND guild_id = $2`,
    [userId, guildId],
  );
  return result.rows[0] ?? emptyUserSwapStats();
}

async function aggregateUserSwapLeaderboard(queryable, guildId, limit) {
  const result = await queryable.query(
    `SELECT user_id,
            SUM(completed_swap_count)::TEXT AS completed_swap_count,
            SUM(total_amount_usd)::TEXT AS total_amount_usd,
            (SUM(total_amount_usd) / 100)::TEXT AS fees_saved_usd
     FROM user_swap_stats
     WHERE guild_id = $1
     GROUP BY user_id
     HAVING SUM(total_amount_usd) > 0
     ORDER BY SUM(total_amount_usd) DESC, SUM(completed_swap_count) DESC, user_id
     LIMIT $2`,
    [guildId, limit],
  );
  return result.rows;
}

function emptyUserSwapStats() {
  return {
    completed_swap_count: '0',
    total_amount_usd: '0',
    fees_saved_usd: '0',
  };
}

function normalizePositiveDecimal(value) {
  const input = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input)) return null;
  if (!/[1-9]/.test(input)) return null;
  return input;
}

function normalizedDepositedAmount(response) {
  const value = String(response?.swapDetails?.depositedAmount ?? '').trim();
  return /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : null;
}
