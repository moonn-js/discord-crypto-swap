import { describe, expect, it, vi } from 'vitest';
import { ensureDatabaseSchema } from '../src/db/migrate.js';

describe('database schema isolation', () => {
  it('creates a configured non-public schema before migrations', async () => {
    const pool = { query: vi.fn().mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({}) };
    await ensureDatabaseSchema(pool, 'swapbot_custom');
    expect(pool.query).toHaveBeenNthCalledWith(1, 'SELECT 1 FROM pg_namespace WHERE nspname = $1', ['swapbot_custom']);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenCalledWith('CREATE SCHEMA IF NOT EXISTS "swapbot_custom"');
  });

  it('reuses an existing schema without requiring database-level CREATE permission', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    await ensureDatabaseSchema(pool, 'swapbot_custom');
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledWith('SELECT 1 FROM pg_namespace WHERE nspname = $1', ['swapbot_custom']);
  });

  it('leaves the default public schema unchanged and rejects unsafe names', async () => {
    const pool = { query: vi.fn() };
    await ensureDatabaseSchema(pool, 'public');
    expect(pool.query).not.toHaveBeenCalled();
    await expect(ensureDatabaseSchema(pool, 'invalid-schema')).rejects.toThrow(/schema name/i);
  });
});
