import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function ensureDatabaseSchema(pool, schema) {
  if (schema === 'public') return;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new TypeError('Invalid PostgreSQL schema name.');
  const existing = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
  if (existing.rowCount > 0) return;
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
}

export async function runMigrations(pool, logger) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationDirectory = path.join(rootDirectory, 'migrations');
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    const alreadyApplied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (alreadyApplied.rowCount > 0) continue;

    const sql = await readFile(path.join(migrationDirectory, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger?.info({ migration: file }, 'Database migration applied');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
