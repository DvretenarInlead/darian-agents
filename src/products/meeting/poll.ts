import type { Pool } from 'pg';
import type { FirefliesClient } from '../../integrations/fireflies/client.js';
import { enqueueJob, type EnqueueInput, type EnqueueResult } from '../../core/queue/jobs.js';
import { appendAudit, type AuditEvent } from '../../core/audit/writer.js';

/**
 * Pull-based Fireflies ingestion, the backstop beside the webhook trigger: on
 * a schedule, list the newest transcripts and enqueue a meeting_ingest job for
 * each one we have not seen. Idempotent end-to-end — the job dedupe key is the
 * meeting id, so re-polling (or a webhook arriving for the same meeting) is a
 * no-op, and the reconciliation ledger dedupes at item level besides.
 *
 * The worker runs this under a cron advisory lock, so multiple instances never
 * double-poll.
 */

export interface PollDeps {
  pool: Pool;
  fireflies: Pick<FirefliesClient, 'listRecentTranscripts'>;
  /** ISO clock (injected for tests/audit determinism). */
  now: () => string;
  /** How many newest transcripts to examine per poll. */
  limit?: number;
  /** Injectable for tests; default to the real queue/audit. */
  enqueue?: (pool: Pool, input: EnqueueInput) => Promise<EnqueueResult>;
  audit?: (event: AuditEvent, nowIso: string) => Promise<unknown>;
}

export interface PollSummary {
  listed: number;
  enqueued: number;
}

export async function pollFireflies(deps: PollDeps): Promise<PollSummary> {
  const enqueue = deps.enqueue ?? enqueueJob;
  const audit = deps.audit ?? ((event: AuditEvent, at: string) => appendAudit(deps.pool, event, at));

  const metas = await deps.fireflies.listRecentTranscripts(deps.limit ?? 25);
  let enqueuedCount = 0;

  for (const meta of metas) {
    const { enqueued } = await enqueue(deps.pool, {
      kind: 'meeting_ingest',
      // Same payload shape the webhook path produces, so the handler is shared.
      payload: { source: 'fireflies-poll', deliveryId: `poll:${meta.id}`, body: { meetingId: meta.id } },
      dedupeKey: `meeting_ingest:${meta.id}`,
    });
    if (!enqueued) continue; // already known — the common case on every poll
    enqueuedCount++;
    await audit(
      {
        eventType: 'ingest',
        product: 'meeting',
        actorId: null,
        subjectId: meta.id,
        payload: { kind: 'fireflies_poll', title: meta.title, date: meta.dateIso },
      },
      deps.now(),
    );
  }

  return { listed: metas.length, enqueued: enqueuedCount };
}
