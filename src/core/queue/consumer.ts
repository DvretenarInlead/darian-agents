import type { Job } from './jobs.js';

/**
 * Generic queue consumer loop (code-review P0). Dependency-injected so the
 * loop — claim → dispatch by kind → complete/fail → idle-sleep when empty — is
 * testable with fakes (no DB). The worker entrypoint binds these to the real
 * Postgres queue.
 */

export type JobHandler = (job: Job) => Promise<void>;

export interface ConsumerDeps {
  claim: () => Promise<Job | null>;
  complete: (job: Job) => Promise<void>;
  fail: (job: Job, error: string) => Promise<void>;
  handlers: Record<string, JobHandler>;
  sleep: (ms: number) => Promise<void>;
  /** Loop continues while this returns false. */
  stopped: () => boolean;
  /** Pause when the queue is empty. */
  idleMs?: number;
  /** Optional structured logger for failures/dispatch. */
  onError?: (job: Job, err: unknown) => void;
}

export async function runConsumer(deps: ConsumerDeps): Promise<void> {
  const idleMs = deps.idleMs ?? 1000;
  while (!deps.stopped()) {
    const job = await deps.claim();
    if (!job) {
      await deps.sleep(idleMs);
      continue;
    }
    await dispatch(deps, job);
  }
}

/** Run one job through its handler; complete on success, fail (retry) on error. */
export async function dispatch(deps: ConsumerDeps, job: Job): Promise<void> {
  const handler = deps.handlers[job.kind];
  if (!handler) {
    await deps.fail(job, `no handler for job kind '${job.kind}'`);
    return;
  }
  try {
    await handler(job);
    await deps.complete(job);
  } catch (err) {
    deps.onError?.(job, err);
    await deps.fail(job, err instanceof Error ? err.message : String(err));
  }
}
