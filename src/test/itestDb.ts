import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';

/**
 * Integration-test DB harness. Connects to INTEGRATION_DATABASE_URL, resets the
 * public schema, and applies every migration in order — so the integration
 * suite runs the REAL SQL (the unit suite only stubs it). Skipped entirely when
 * the env var is absent (local default).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export const INTEGRATION_URL = process.env.INTEGRATION_DATABASE_URL;

export function makeTestPool(): Pool {
  if (!INTEGRATION_URL) throw new Error('INTEGRATION_DATABASE_URL is not set');
  return new Pool({ connectionString: INTEGRATION_URL, max: 4 });
}

export async function resetAndMigrate(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await pool.query(sql);
  }
}
