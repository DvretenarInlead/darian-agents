import type { ManagedAgentsClient, RawSessionEvent } from '../../integrations/anthropic/managedAgents.js';
import { log } from '../../core/obs/logger.js';
import { teamStreamsOpen } from '../../core/obs/metrics.js';
import { processEvent } from './events.js';
import type { StreamDeps, TeamRun } from './types.js';

/**
 * One serial connect loop per run. Stream-first ordering: the SSE connection is
 * opened BEFORE the history is listed, so nothing emitted in between is lost;
 * the seen-ledger inside processEvent makes the overlap harmless.
 */

export interface RunStreamDeps extends StreamDeps {
  client: ManagedAgentsClient;
  sleep: (ms: number) => Promise<void>;
}

export const backoffMs = (attempt: number, jitter = Math.random() * 1_000): number =>
  Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 10)) + Math.floor(jitter);

/** Resolves when the signal aborts (immediately if it already has). */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Keeps the run's stream connected until `signal` aborts or a terminal event is
 * processed. Never throws: every failure is logged and retried with backoff.
 */
export async function runStream(deps: RunStreamDeps, run: TeamRun, signal: AbortSignal): Promise<void> {
  const sessionId = run.sessionId;
  if (!sessionId) return;
  let attempt = 0;

  while (!signal.aborted) {
    const attemptCtl = new AbortController();
    const onAbort = () => attemptCtl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let iterator: AsyncIterator<RawSessionEvent> | null = null;
    let open = false;
    try {
      const stream = await deps.client.openEventStream(sessionId, attemptCtl.signal);
      iterator = stream[Symbol.asyncIterator]();
      open = true;
      teamStreamsOpen.inc();
      attempt = 0;

      for await (const e of deps.client.listEvents(sessionId)) {
        if (signal.aborted) return;
        if ((await processEvent(deps, run, e)).terminal) return;
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done || signal.aborted) break;
        const r = await processEvent(deps, run, next.value);
        if (r.terminal) return;
      }
    } catch (err) {
      if (!signal.aborted) log().warn({ runId: run.id, err: String(err) }, 'team stream failed; will reconnect');
    } finally {
      signal.removeEventListener('abort', onAbort);
      attemptCtl.abort();
      if (iterator) await release(iterator);
      if (open) teamStreamsOpen.dec();
    }
    if (signal.aborted) return;

    const wait = backoffMs(attempt++);
    await Promise.race([deps.sleep(wait), aborted(signal)]);
  }
}

/**
 * Finish the iterator after the connection was aborted. An async generator that
 * was never started does not run its cleanup on return(), so step it once first:
 * the abort has already queued its end marker.
 */
async function release(it: AsyncIterator<RawSessionEvent>): Promise<void> {
  try {
    await it.next();
  } catch {
    /* aborted streams may reject */
  }
  try {
    await it.return?.();
  } catch {
    /* ignore */
  }
}
