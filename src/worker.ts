import { config } from './config/index.js';
import { getPool, closePool } from './core/db/index.js';

/**
 * Worker entrypoint (build-order step 8). Runs async jobs off the main web
 * service: meeting extraction → board → HubSpot sync, repo scoring, cron-locked
 * scheduled work. At this stage it boots, validates config, verifies DB
 * connectivity, and idles; the job-queue consumer wiring (pulling enqueued
 * webhook deliveries / on-demand runs through processMeeting / scoreRepo) is the
 * remaining integration piece and attaches here.
 */
async function start(): Promise<void> {
  const cfg = config();
  const pool = getPool();
  await pool.query('SELECT 1'); // fail fast if the DB is unreachable
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg: 'worker started', env: cfg.env }));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: 'info', msg: 'worker shutting down', signal }));
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Idle until a signal arrives; the queue consumer loop will live here.
  await new Promise<void>(() => {});
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
