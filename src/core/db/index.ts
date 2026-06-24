import { Pool, type PoolConfig } from 'pg';
import { config } from '../../config/index.js';

/**
 * Single shared pg Pool. The app connects with the least-privilege `app_rw`
 * role (see migrations/0001_init.sql) which has no UPDATE/DELETE on audit_log.
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const cfg = config();
    const poolConfig: PoolConfig = {
      connectionString: cfg.db.url,
      ssl: cfg.db.ssl ? { rejectUnauthorized: true } : false,
    };
    pool = new Pool(poolConfig);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
