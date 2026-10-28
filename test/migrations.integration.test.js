import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { Repositories } from '../src/db/repositories.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('PostgreSQL migrations and ticket constraints', () => {
  let pool;
  let repositories;
  const guildId = `test-guild-${Date.now()}`;
  const userId = `test-user-${Date.now()}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await runMigrations(pool);
    repositories = new Repositories(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM tickets WHERE guild_id = $1', [guildId]);
      await pool.query('DELETE FROM user_chain_addresses WHERE guild_id = $1', [guildId]);
      await pool.end();
    }
  });

  it('atomically enforces three active tickets per user', async () => {
    const attempts = await Promise.all(Array.from({ length: 4 }, () => (
      repositories.reserveTicket({ id: randomUUID(), guildId, userId })
    )));
    expect(attempts.filter((attempt) => attempt.created)).toHaveLength(3);
    expect(attempts.filter((attempt) => !attempt.created)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.created).every((attempt) => attempt.ticket.step === 'ORIGIN_COIN')).toBe(true);
    await expect(repositories.getOpenTicketsForUser(guildId, userId)).resolves.toHaveLength(3);
  });

  it('updates and retrieves the latest address independently per blockchain', async () => {
    await repositories.saveUserChainAddress(guildId, userId, 'eth', '0x-first');
    await repositories.saveUserChainAddress(guildId, userId, 'eth', '0x-latest');
    await repositories.saveUserChainAddress(guildId, userId, 'sol', 'sol-address');

    await expect(repositories.getUserChainAddress(guildId, userId, 'eth')).resolves.toBe('0x-latest');
    await expect(repositories.getUserChainAddress(guildId, userId, 'sol')).resolves.toBe('sol-address');
    await expect(repositories.getUserChainAddress(guildId, 'someone-else', 'eth')).resolves.toBeNull();
  });
});
