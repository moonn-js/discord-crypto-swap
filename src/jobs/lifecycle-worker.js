import { ChannelType } from 'discord.js';

const ROUTE_WATCH_INTERVAL_MS = 60_000;
const ROUTE_WATCH_LEASE_MS = 5 * 60_000;

export class LifecycleWorker {
  constructor({ repositories, client, ticketService, config, logger }) {
    this.repositories = repositories;
    this.client = client;
    this.ticketService = ticketService;
    this.config = config;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.timer = setInterval(() => {
      this.run().catch((error) => this.logger.error({ errorCode: 'LIFECYCLE_WORKER_FAILED', errorName: error.name }, 'Lifecycle worker iteration failed'));
    }, 30_000);
    this.timer.unref?.();
    void this.run();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const watchedRoutes = await this.repositories.claimDueRouteWatches?.(
        new Date(now - ROUTE_WATCH_INTERVAL_MS),
        new Date(now - ROUTE_WATCH_LEASE_MS),
        10,
      ) ?? [];
      for (const ticket of watchedRoutes) {
        try {
          await this.ticketService.checkWatchedPopularRoute(ticket);
        } catch (error) {
          if (typeof this.repositories.completeRouteWatchCheck === 'function') {
            await this.repositories.completeRouteWatchCheck(ticket.id, ticket.route_watch_claimed_at).catch(() => null);
          }
          this.logger.warn({
            ticketId: ticket.id,
            errorName: error.name,
            errorCode: 'ROUTE_WATCH_CHECK_FAILED',
          }, 'Watched popular route check will be retried');
        }
      }

      const inactiveCutoff = new Date(now - this.config.ticketInactivityMs);
      const inactive = await this.repositories.claimInactiveDraftTickets(inactiveCutoff);
      for (const ticket of inactive) await this.deleteTicketChannel(ticket);

      const reminderCutoff = new Date(now - this.config.ticketInactivityReminderMs);
      const reminderLeaseBefore = new Date(now - 5 * 60_000);
      const reminders = await this.repositories.claimInactiveTicketReminders(reminderCutoff, inactiveCutoff, reminderLeaseBefore);
      for (const ticket of reminders) await this.sendInactivityReminder(ticket);

      const due = await this.repositories.listTicketsDueForDeletion(new Date());
      for (const ticket of due) await this.deleteTicketChannel(ticket);

      const pendingSummaries = await this.repositories.listPendingCompletionSummaries(
        new Date(Date.now() - 5 * 60_000),
      );
      for (const swap of pendingSummaries) await this.ticketService.publishCompletionSummary(swap);

      const vouchGuildIds = this.ticketService.getVouchGuildIds?.()
        ?? (this.config.vouchChannelId && this.config.guildId ? [this.config.guildId] : []);
      if (vouchGuildIds.length > 0) {
        const pendingVouchDms = await this.repositories.listPendingCompletionVouchDms(
          new Date(Date.now() - 5 * 60_000),
          25,
          vouchGuildIds,
        );
        for (const swap of pendingVouchDms) await this.ticketService.notifyCompletionVouch(swap);
      }

      const deletedCount = await this.repositories.deleteExpiredRecords(
        new Date(Date.now() - this.config.terminalRetentionMs),
        new Date(Date.now() - this.config.abandonedRetentionMs),
      );
      if (deletedCount > 0) this.logger.info({ deletedCount }, 'Expired ticket records removed');
    } finally {
      this.running = false;
    }
  }

  async deleteTicketChannel(ticket) {
    if (ticket.channel_id) {
      const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
      if (channel && channel.type === ChannelType.GuildText) {
        try {
          if (ticket.closure_reason !== 'INACTIVITY') {
            await this.ticketService.archiveFinalTicketTranscript(ticket, channel);
          }
          await channel.delete('Private swap ticket retention elapsed');
        } catch (error) {
          this.logger.warn({ ticketId: ticket.id, errorCode: 'CHANNEL_DELETE_FAILED', errorName: error.name }, 'Ticket channel deletion will be retried');
          return;
        }
      }
    }
    await this.repositories.markTicketDeleted(ticket.id);
    if (ticket.closure_reason === 'INACTIVITY') await this.ticketService.notifyInactivityClosure(ticket);
    this.logger.info({ ticketId: ticket.id }, 'Private ticket channel deleted');
  }

  async sendInactivityReminder(ticket) {
    const current = typeof this.repositories.getTicket === 'function'
      ? await this.repositories.getTicket(ticket.id)
      : ticket;
    if (current?.route_watch_action && !current.route_watch_notified_at) {
      await this.repositories.releaseInactivityReminder(ticket.id, ticket.inactivity_reminder_claimed_at);
      return;
    }
    if (!ticket.channel_id) {
      await this.repositories.releaseInactivityReminder(ticket.id, ticket.inactivity_reminder_claimed_at);
      return;
    }
    const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await this.repositories.releaseInactivityReminder(ticket.id, ticket.inactivity_reminder_claimed_at);
      return;
    }
    const closesAt = new Date(new Date(ticket.last_activity_at).getTime() + this.config.ticketInactivityMs);
    const unix = Math.floor(closesAt.getTime() / 1000);
    const reminderMinutes = Math.round(this.config.ticketInactivityReminderMs / 60_000);
    const content = `<@${ticket.user_id}>, your ticket has been inactive for ${reminderMinutes} minutes. Continue the setup or use any ticket control to keep it open. It will close <t:${unix}:F> (<t:${unix}:R>) if there is no activity.`;
    try {
      const recent = channel.messages?.fetch
        ? await channel.messages.fetch({ limit: 100 }).catch(() => null)
        : null;
      const alreadySent = recent && [...recent.values()].some((message) => (
        message.author?.id === this.client.user?.id && message.content === content
      ));
      if (!alreadySent) {
        await channel.send({ content, allowedMentions: { users: [ticket.user_id] } });
      }
      await this.repositories.completeInactivityReminder(ticket.id, ticket.inactivity_reminder_claimed_at);
    } catch (error) {
      await this.repositories.releaseInactivityReminder(ticket.id, ticket.inactivity_reminder_claimed_at);
      this.logger.warn({ ticketId: ticket.id, errorName: error.name, errorCode: 'INACTIVITY_REMINDER_FAILED' }, 'Could not send inactivity reminder; it will be retried');
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
