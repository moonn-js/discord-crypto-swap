import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const validEnvironment = {
  DISCORD_TOKEN: 'discord-token-with-enough-characters',
  DISCORD_GUILD_ID: '123456789012345678',
  PANEL_CHANNEL_ID: '123456789012345679',
  TICKET_CATEGORY_ID: '123456789012345680',
  COMPLETED_DEALS_CHANNEL_ID: '123456789012345681',
  ONECLICK_JWT: 'oneclick-jwt-with-enough-characters',
  DATABASE_URL: 'postgresql://localhost/swapbot',
};

describe('configuration', () => {
  it('applies the locked safety defaults', () => {
    const config = loadConfig(validEnvironment);
    expect(config.slippageBps).toBe(50);
    expect(config.completedDealsChannelId).toBe('123456789012345681');
    expect(config.transcriptChannelId).toBeNull();
    expect(config.vouchChannelId).toBeNull();
    expect(config.selfServiceSetupEnabled).toBe(false);
    expect(config.centralTranscriptGuildId).toBeNull();
    expect(config.centralTranscriptChannelId).toBeNull();
    expect(config.fundingDeadlineMs).toBe(60 * 60_000);
    expect(config.targetTotalCostBps).toBe(0);
    expect(config.botFeeRecipient).toBeNull();
    expect(config.databaseSchema).toBe('public');
    expect(config.channelDeleteDelayMs).toBe(5 * 60_000);
    expect(config.ticketInactivityReminderMs).toBe(5 * 60_000);
    expect(config.payoutMonitorIntervalMs).toBe(2_000);
    expect(config.blockCypherApiToken).toBeNull();
    expect(config.heliusApiKey).toBeNull();
    expect(config.solanaPayoutRpcUrl).toBe('https://solana-rpc.publicnode.com');
    expect(config.solanaPayoutWebSocketUrl).toBe('wss://solana-rpc.publicnode.com');
    expect(config.evmPayoutRpcUrls.eth).toBe('https://ethereum-rpc.publicnode.com');
    expect(config.evmPayoutRpcUrls.bsc).toBe('https://bsc-rpc.publicnode.com');
  });

  it('rejects slippage above the operator safety cap', () => {
    expect(() => loadConfig({ ...validEnvironment, SLIPPAGE_BPS: '501' })).toThrow('SLIPPAGE_BPS');
  });

  it('accepts an optional completion-vouch channel', () => {
    const config = loadConfig({ ...validEnvironment, VOUCH_CHANNEL_ID: '1522362740415660113' });
    expect(config.vouchChannelId).toBe('1522362740415660113');
    expect(() => loadConfig({ ...validEnvironment, VOUCH_CHANNEL_ID: 'not-a-channel' })).toThrow('VOUCH_CHANNEL_ID');
  });

  it('enables self-service setup and validates the private transcript destination as a pair', () => {
    const config = loadConfig({
      ...validEnvironment,
      SELF_SERVICE_SETUP_ENABLED: 'true',
      CENTRAL_TRANSCRIPT_GUILD_ID: '1511062369176911973',
      CENTRAL_TRANSCRIPT_CHANNEL_ID: '1511062869255651570',
    });
    expect(config.selfServiceSetupEnabled).toBe(true);
    expect(config.centralTranscriptGuildId).toBe('1511062369176911973');
    expect(config.centralTranscriptChannelId).toBe('1511062869255651570');
    expect(() => loadConfig({
      ...validEnvironment,
      CENTRAL_TRANSCRIPT_CHANNEL_ID: '1511062869255651570',
    })).toThrow('CENTRAL_TRANSCRIPT_GUILD_ID');
  });

  it('accepts any number of guild configurations while preserving primary-guild aliases', () => {
    const guilds = [
      {
        guildId: '123456789012345678',
        panelChannelId: '123456789012345679',
        ticketCategoryId: '123456789012345680',
        completedDealsChannelId: '123456789012345681',
        transcriptChannelId: '123456789012345682',
        vouchChannelId: null,
      },
      {
        guildId: '223456789012345678',
        panelChannelId: '223456789012345679',
        ticketCategoryId: '223456789012345680',
        completedDealsChannelId: '223456789012345681',
        transcriptChannelId: '223456789012345682',
        vouchChannelId: '223456789012345683',
      },
    ];
    const config = loadConfig({
      DISCORD_TOKEN: validEnvironment.DISCORD_TOKEN,
      DISCORD_GUILDS_JSON: JSON.stringify(guilds),
      ONECLICK_JWT: validEnvironment.ONECLICK_JWT,
      DATABASE_URL: validEnvironment.DATABASE_URL,
    });

    expect(config.guilds).toEqual(guilds);
    expect(config.guildId).toBe(guilds[0].guildId);
    expect(config.completedDealsChannelId).toBe(guilds[0].completedDealsChannelId);
    expect(config.vouchChannelId).toBeNull();
  });

  it('rejects malformed, duplicate, empty, or incomplete multi-guild configuration', () => {
    const base = {
      DISCORD_TOKEN: validEnvironment.DISCORD_TOKEN,
      ONECLICK_JWT: validEnvironment.ONECLICK_JWT,
      DATABASE_URL: validEnvironment.DATABASE_URL,
    };
    expect(() => loadConfig({ ...base, DISCORD_GUILDS_JSON: '{bad' })).toThrow('DISCORD_GUILDS_JSON');
    expect(() => loadConfig({ ...base, DISCORD_GUILDS_JSON: '[]' })).toThrow('DISCORD_GUILDS_JSON');
    const guild = {
      guildId: '123456789012345678',
      panelChannelId: '123456789012345679',
      ticketCategoryId: '123456789012345680',
      completedDealsChannelId: '123456789012345681',
      transcriptChannelId: '123456789012345682',
    };
    expect(() => loadConfig({ ...base, DISCORD_GUILDS_JSON: JSON.stringify([guild, guild]) })).toThrow('duplicate guildId');
    expect(() => loadConfig({
      ...base,
      DISCORD_GUILDS_JSON: JSON.stringify([{ guildId: guild.guildId }]),
    })).toThrow('DISCORD_GUILDS_JSON');
  });

  it('accepts safe isolated PostgreSQL schema names', () => {
    expect(loadConfig({ ...validEnvironment, DATABASE_SCHEMA: 'swapbot_custom' }).databaseSchema).toBe('swapbot_custom');
    expect(() => loadConfig({ ...validEnvironment, DATABASE_SCHEMA: 'invalid-schema' })).toThrow('DATABASE_SCHEMA');
  });

  it('requires a fee recipient only when the total-cost target is enabled', () => {
    expect(() => loadConfig({ ...validEnvironment, TARGET_TOTAL_COST_BPS: '30' })).toThrow('BOT_FEE_RECIPIENT');
    const config = loadConfig({
      ...validEnvironment,
      TARGET_TOTAL_COST_BPS: '30',
      BOT_FEE_RECIPIENT: 'fee-recipient.near',
    });
    expect(config.targetTotalCostBps).toBe(30);
    expect(config.botFeeRecipient).toBe('fee-recipient.near');
  });

  it('requires Discord, database, and 1Click secrets', () => {
    expect(() => loadConfig({})).toThrow('Invalid configuration');
  });

  it('requires the inactivity reminder to occur before closure', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      TICKET_INACTIVITY_MINUTES: '30',
      TICKET_INACTIVITY_REMINDER_MINUTES: '30',
    })).toThrow('TICKET_INACTIVITY_REMINDER_MINUTES');
  });

  it('requires a complete and HTTPS BlockCypher webhook configuration', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      BLOCKCYPHER_API_TOKEN: 'token',
    })).toThrow('PAYOUT_WEBHOOK_BASE_URL');
    expect(() => loadConfig({
      ...validEnvironment,
      BLOCKCYPHER_API_TOKEN: 'token',
      PAYOUT_WEBHOOK_BASE_URL: 'http://bot.example',
      PAYOUT_WEBHOOK_SECRET: 'abcdefghijklmnopqrstuvwxyz123456',
    })).toThrow('PAYOUT_WEBHOOK_BASE_URL');
    const config = loadConfig({
      ...validEnvironment,
      BLOCKCYPHER_API_TOKEN: 'token',
      PAYOUT_WEBHOOK_BASE_URL: 'https://bot.example',
      PAYOUT_WEBHOOK_SECRET: 'abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(config.blockCypherApiToken).toBe('token');
  });

  it('accepts only HTTP(S) EVM payout RPC URLs', () => {
    expect(loadConfig({
      ...validEnvironment,
      PAYOUT_BSC_RPC_URL: 'https://bsc.example',
    }).evmPayoutRpcUrls.bsc).toBe('https://bsc.example');
    expect(() => loadConfig({
      ...validEnvironment,
      PAYOUT_BSC_RPC_URL: 'wss://bsc.example',
    })).toThrow('PAYOUT_BSC_RPC_URL');
  });

  it('accepts only WSS Solana payout WebSocket URLs', () => {
    expect(loadConfig({
      ...validEnvironment,
      PAYOUT_SOL_RPC_URL: 'https://solana.example',
      PAYOUT_SOL_WS_URL: 'wss://solana.example',
    }).solanaPayoutWebSocketUrl).toBe('wss://solana.example');
    expect(() => loadConfig({
      ...validEnvironment,
      PAYOUT_SOL_WS_URL: 'https://solana.example',
    })).toThrow('PAYOUT_SOL_WS_URL');
    expect(() => loadConfig({
      ...validEnvironment,
      PAYOUT_SOL_RPC_URL: 'https://solana.example',
    })).toThrow('PAYOUT_SOL_RPC_URL');
  });
});
