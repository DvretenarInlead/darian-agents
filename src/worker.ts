import { config } from './config/index.js';
import { getPool, closePool } from './core/db/index.js';
import { claimJob, completeJob, failJob, retryDelaySec, type Job } from './core/queue/jobs.js';
import { runConsumer, type JobHandler } from './core/queue/consumer.js';
import { log, runWithCorrelation } from './core/obs/logger.js';
import { jobsProcessed } from './core/obs/metrics.js';

/**
 * Worker entrypoint (code-review P0). Drains the durable job queue and runs the
 * product pipelines. Many worker instances can run concurrently — claimJob uses
 * FOR UPDATE SKIP LOCKED so each grabs a distinct job. Failures re-queue with
 * backoff until max_attempts, then dead-letter.
 *
 * Handlers are registered by kind. The meeting_ingest handler needs the
 * Fireflies transcript fetch (a thin adapter, pending API confirmation) before
 * it can run the full pipeline end-to-end; it is intentionally a clear stub so
 * the queue/worker machinery is complete and testable now.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wrap a handler so each job runs under its own correlation id. */
const withCorrelation = (handler: JobHandler): JobHandler => (job) =>
  runWithCorrelation(job.id, () => handler(job));

const handlers: Record<string, JobHandler> = {
  meeting_ingest: withCorrelation(async (job: Job) => {
    // TODO(meeting): fetch the transcript via the Fireflies adapter (pending API
    // confirmation), then call processMeeting(deps, { meetingId, transcript }).
    log().info({ jobId: job.id }, 'meeting_ingest received');
  }),
  repo_score: withCorrelation(async (job: Job) => {
    // TODO(repo): clone into the sandbox, then call scoreRepo(deps, { repo, rootDir }).
    log().info({ jobId: job.id }, 'repo_score received');
  }),
};

async function start(): Promise<void> {
  const cfg = config();
  const pool = getPool();
  await pool.query('SELECT 1'); // fail fast if the DB is unreachable
  log().info({ env: cfg.env }, 'worker started');

  let stopping = false;
  const stopped = () => stopping;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log().info({ signal }, 'worker draining for shutdown');
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await runConsumer({
    claim: () => claimJob(pool),
    complete: (job) => {
      jobsProcessed.inc({ kind: job.kind, outcome: 'done' });
      return completeJob(pool, job.id);
    },
    fail: (job, error) => {
      jobsProcessed.inc({ kind: job.kind, outcome: job.attempts >= job.maxAttempts ? 'dead' : 'retry' });
      return failJob(pool, job, error, retryDelaySec(job.attempts));
    },
    handlers,
    sleep,
    stopped,
    onError: (job, err) => log().error({ jobId: job.id, kind: job.kind, err: String(err) }, 'job failed'),
  });

  await closePool();
  process.exit(0);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
