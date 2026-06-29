import type { Pool } from 'pg';
import type { JobHandler } from '../../core/queue/consumer.js';
import type { Job } from '../../core/queue/jobs.js';
import type { LlmClient } from '../../integrations/anthropic/client.js';
import type { FirefliesClient } from '../../integrations/fireflies/client.js';
import type { HubSpotClient } from '../../integrations/hubspot/client.js';
import { loadResolutionPolicy } from '../../core/orchestrator/policy.js';
import { LlmExtractor } from './extract.js';
import { LlmBoardRunner } from './board.js';
import { loadAgentPrompts } from './prompts.js';
import { processMeeting } from './pipeline.js';
import { log } from '../../core/obs/logger.js';

/**
 * meeting_ingest job handler: turns a verified Fireflies webhook into a run of
 * the (already-tested) meeting pipeline — fetch transcript → processMeeting
 * (extraction → reconciliation → board → HubSpot sync). Wiring only; the logic
 * lives in the tested pipeline modules.
 */
export interface MeetingHandlerDeps {
  pool: Pool;
  fireflies: FirefliesClient;
  llm: LlmClient;
  hubspot: HubSpotClient;
  projectDefaults: { pipeline: string; pipelineStage: string; type?: string };
}

/** Best-effort extraction of the meeting id from a Fireflies webhook body. */
export function meetingIdFromPayload(payload: unknown): string | null {
  const p = payload as { body?: Record<string, unknown>; deliveryId?: string } | undefined;
  const body = p?.body ?? {};
  const candidate = body.meetingId ?? body.meeting_id ?? (body as { id?: unknown }).id;
  return typeof candidate === 'string' ? candidate : null;
}

export function makeMeetingHandler(deps: MeetingHandlerDeps): JobHandler {
  return async (job: Job) => {
    const meetingId = meetingIdFromPayload(job.payload);
    if (!meetingId) throw new Error('meeting_ingest: no meetingId in payload');

    const transcript = await deps.fireflies.fetchTranscript(meetingId);
    const promptFor = await loadAgentPrompts(deps.pool);
    const policy = await loadResolutionPolicy(deps.pool);

    const summary = await processMeeting(
      {
        pool: deps.pool,
        extractor: new LlmExtractor(deps.llm),
        board: { runner: new LlmBoardRunner(deps.llm, promptFor), policy },
        hubspot: deps.hubspot,
        projectDefaults: deps.projectDefaults,
        now: () => new Date().toISOString(),
      },
      { meetingId, transcript, apply: true },
    );
    log().info({ jobId: job.id, ...summary }, 'meeting_ingest processed');
  };
}
