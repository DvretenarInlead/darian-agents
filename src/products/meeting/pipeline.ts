import type { Pool } from 'pg';
import type { BoardAgent } from '../../core/agents/contract.js';
import type { ResolutionPolicyEntry } from '../../core/orchestrator/resolution.js';
import { appendAudit } from '../../core/audit/writer.js';
import type { HubSpotClient } from '../../integrations/hubspot/client.js';
import { buildSyncPlan, type ApprovedItem } from '../../integrations/hubspot/plan.js';
import { runSync } from '../../integrations/hubspot/sync.js';
import type { ProjectInput, TaskInput } from '../../integrations/hubspot/types.js';
import type { Extractor } from './extract.js';
import { reconcileItems } from './reconcile.js';
import { runBoard, type BoardRunner, type BoardSubject } from './board.js';

/**
 * Product A pipeline (build-order step 6): extraction → reconciliation → batched
 * board → HubSpot sync, with audit at each decision point. The webhook receiver
 * (step 4) has already verified+enqueued the delivery; this is the worker path.
 *
 * Board-gated: only items the board clears (`proceed`) are synced; escalations
 * go to the escalation_queue for human approval (approver ≠ configurer is
 * enforced at the console). Nothing irreversible happens without a clear gate.
 */

export interface MeetingPipelineDeps {
  pool: Pool;
  extractor: Extractor;
  board: { runner: BoardRunner; policy: ResolutionPolicyEntry[]; agents?: BoardAgent[] };
  hubspot: HubSpotClient;
  projectDefaults: { pipeline: string; pipelineStage: string; type?: string };
  /** ISO-8601 clock for audit timestamps (injected for testability). */
  now: () => string;
}

export interface ProcessInput {
  meetingId: string;
  transcript: string;
  /** Apply (vs preview-only). Defaults to true: board-cleared items are synced. */
  apply?: boolean;
}

export interface ProcessSummary {
  meetingId: string;
  extracted: number;
  duplicates: number;
  proceeded: number;
  escalated: number;
  quarantined: number;
  synced: boolean;
}

async function findSyncedProject(pool: Pool, meetingId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ hubspot_ref: string }>(
    `SELECT hubspot_ref FROM sync_log
      WHERE subject_id = $1 AND outcome = 'applied' AND hubspot_ref IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [meetingId],
  );
  return rows[0]?.hubspot_ref?.split(',')[0];
}

export async function processMeeting(deps: MeetingPipelineDeps, input: ProcessInput): Promise<ProcessSummary> {
  const { pool, now } = deps;
  const apply = input.apply ?? true;

  const items = await deps.extractor.extract({ meetingId: input.meetingId, transcript: input.transcript });
  const reconciled = await reconcileItems(pool, input.meetingId, items);
  const fresh = reconciled.filter((r) => r.decision !== 'skipped_duplicate');
  const duplicates = reconciled.length - fresh.length;

  const subjects: BoardSubject[] = fresh.map((r) => ({
    subjectId: r.itemHash,
    title: r.item.title,
    description: r.item.description,
    ownerHint: r.item.owner_hint,
    dueHint: r.item.due_hint,
  }));

  const { decisions, quarantines } = await runBoard(
    { runner: deps.board.runner, policy: deps.board.policy, ...(deps.board.agents ? { agents: deps.board.agents } : {}) },
    subjects,
  );

  for (const q of quarantines) {
    await appendAudit(
      pool,
      { eventType: 'autofix', product: 'meeting', actorId: null, subjectId: q.subjectId, payload: { quarantine: q } },
      now(),
    );
  }

  const approvedItems: ApprovedItem[] = [];
  let escalated = 0;
  for (const r of fresh) {
    const decision = decisions.get(r.itemHash);
    if (!decision) continue;
    await appendAudit(
      pool,
      { eventType: 'verdict', product: 'meeting', actorId: null, subjectId: r.itemHash, payload: { decision } },
      now(),
    );
    if (decision.outcome === 'proceed') {
      const task: TaskInput = {
        title: r.item.title,
        ...(r.item.description ? { body: r.item.description } : {}),
        ...(r.item.due_hint ? { dueDate: r.item.due_hint } : {}),
      };
      approvedItems.push({ task, decision: r.decision });
    } else {
      escalated += 1;
      await pool.query(
        `INSERT INTO escalation_queue (product, subject_id, reason, verdicts, status)
         VALUES ('meeting', $1, $2, $3, 'pending')`,
        [r.itemHash, decision.rationale, JSON.stringify(decision)],
      );
      await appendAudit(
        pool,
        { eventType: 'escalation', product: 'meeting', actorId: null, subjectId: r.itemHash, payload: { decision } },
        now(),
      );
    }
  }

  let synced = false;
  if (approvedItems.length > 0) {
    const existingProjectId = await findSyncedProject(pool, input.meetingId);
    const project: ProjectInput = {
      name: `Meeting ${input.meetingId} — action items`,
      pipeline: deps.projectDefaults.pipeline,
      pipelineStage: deps.projectDefaults.pipelineStage,
      ...(deps.projectDefaults.type ? { type: deps.projectDefaults.type } : {}),
    };
    const plan = buildSyncPlan({
      subjectId: input.meetingId,
      project,
      ...(existingProjectId ? { existingProjectId } : {}),
      items: approvedItems,
    });
    const outcome = await runSync(pool, deps.hubspot, plan, apply);
    synced = Boolean(outcome.result);
    await appendAudit(
      pool,
      {
        eventType: 'external_write',
        product: 'meeting',
        actorId: null,
        subjectId: input.meetingId,
        payload: { preview: outcome.preview, applied: synced },
      },
      now(),
    );
  }

  return {
    meetingId: input.meetingId,
    extracted: items.length,
    duplicates,
    proceeded: approvedItems.length,
    escalated,
    quarantined: quarantines.length,
    synced,
  };
}
