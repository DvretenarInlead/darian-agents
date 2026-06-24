/**
 * Minimal forward-only migration runner.
 *
 * Applies every `*.sql` file in /migrations in lexical order that has not yet
 * been recorded in `schema_migrations`. Each file runs inside its own
 * transaction; a failure rolls back that file and aborts the run.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { config } from '../src/config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  const cfg = config();
  const client = new Client({
    connectionString: cfg.db.url,
    ssl: cfg.db.ssl ? { rejectUnauthorized: true } : false,
  });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`Applying ${file}… `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        process.stdout.write('ok\n');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        process.stdout.write('failed\n');
        throw err;
      }
    }

    console.log(count === 0 ? 'No pending migrations.' : `Applied ${count} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
