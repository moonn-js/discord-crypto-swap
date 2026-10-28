import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config);

try {
  await runMigrations(pool, logger);
  logger.info('Database is up to date');
} finally {
  await pool.end();
}
