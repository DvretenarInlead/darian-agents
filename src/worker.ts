import { config } from './config/index.js';
import { getPool, closePool } from './core/db/index.js';
import { claimJob, completeJob, failJob, retryDelaySec } from './core/queue/jobs.js';
import { runConsumer, type JobHandler } from './core/queue/consumer.js';
import { log, runWithCorrelation } from './core/obs/logger.js';
import { jobsProcessed } from './core/obs/metrics.js';
import { AnthropicLlmClient } from './integrations/anthropic/client.js';
import { GraphqlFirefliesClient } from './integrations/fireflies/client.js';
import { createHubSpotClient } from './integrations/hubspot/index.js';
import { makeMeetingHandler } from './products/meeting/handler.js';
import { pollFireflies } from './products/meeting/poll.js';
import { makeRepoHandler } from './products/repo/handler.js';
import { withCronLock } from './core/triggers/cronLock.js';

/**
 * Worker entrypoint (code-review P0). Drains the durable job queue and runs the
 * product pipelines end-to-end. Many worker instances can run concurrently —
 * claimJob uses FOR UPDATE SKIP LOCKED so each grabs a distinct job. Failures
 * re-queue with backoff until max_attempts, then dead-letter.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wrap a handler so each job runs under its own correlation id. */
const withCorrelation = (handler: JobHandler): JobHandler => (job) =>
  runWithCorrelation(job.id, () => handler(job));

async function start(): Promise<void> {
  const cfg = config();
  const pool = getPool();
  await pool.query('SELECT 1'); // fail fast if the DB is unreachable
  log().info({ env: cfg.env }, 'worker started');

  const llm = new AnthropicLlmClient();
  const fireflies = new GraphqlFirefliesClient();
  const handlers: Record<string, JobHandler> = {
    meeting_ingest: withCorrelation(
      makeMeetingHandler({
        pool,
        fireflies,
        llm,
        hubspot: createHubSpotClient(),
        projectDefaults: {
          pipeline: process.env.HUBSPOT_PROJECT_PIPELINE ?? 'default',
          pipelineStage: process.env.HUBSPOT_PROJECT_STAGE ?? 'new',
        },
      }),
    ),
    repo_score: withCorrelation(makeRepoHandler({ pool, llm })),
  };

  let stopping = false;
  const stopped = () => stopping;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log().info({ signal }, 'worker draining for shutdown');
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Pull-based Fireflies ingestion: list newest transcripts on an interval and
  // enqueue unseen ones (idempotent via job dedupe on meeting id). Complements
  // the webhook trigger — webhook fires instantly, the poller catches anything
  // a missed/failed webhook would drop. Cron advisory lock keeps it
  // single-flight across worker instances.
  const pollMs = cfg.fireflies.pollMinutes * 60_000;
  const pollerDone = (async () => {
    if (!cfg.fireflies.apiKey || pollMs === 0) return;
    log().info({ intervalMin: cfg.fireflies.pollMinutes }, 'fireflies poller active');
    while (!stopping) {
      try {
        const run = await withCronLock(pool, 'fireflies_poll', () =>
          pollFireflies({ pool, fireflies, now: () => new Date().toISOString() }),
        );
        if (run.ran && run.result && run.result.enqueued > 0) {
          log().info(run.result, 'fireflies poll enqueued new meetings');
        }
      } catch (err) {
        log().error({ err: String(err) }, 'fireflies poll failed; will retry next interval');
      }
      // Sleep in short slices so shutdown stays prompt.
      for (let waited = 0; waited < pollMs && !stopping; waited += 1_000) await sleep(1_000);
    }
  })();

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

  await pollerDone;
  await closePool();
  process.exit(0);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
