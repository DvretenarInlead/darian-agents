import type { OwnerQuery, OwnerRef, SyncPlan, SyncPreview, SyncResult, SyncOp } from './types.js';

/**
 * The port every consumer uses. Three concrete adapters implement it:
 *  - AgentCliHubSpotClient  (primary; agentCli.ts) — HubSpot Agent CLI, beta.
 *  - ProjectsApiHubSpotClient (fallback; projectsApi.ts) — version-pinned REST.
 *  - InMemoryHubSpotClient   (below) — deterministic, for tests/dry-run demos.
 *
 * `preview()` is the board-gated `--dry-run`: it returns what *would* happen and
 * mutates nothing. `apply()` performs the writes and is only ever called for a
 * board-approved plan.
 */
export interface HubSpotClient {
  /** Privileged, admin-mode owner resolution (isolated from extraction). */
  resolveOwner(query: OwnerQuery): Promise<OwnerRef | null>;
  /** Dry-run preview — no mutations. */
  preview(plan: SyncPlan): Promise<SyncPreview>;
  /** Apply a board-approved plan. */
  apply(plan: SyncPlan): Promise<SyncResult>;
}

/** Shared dry-run rendering so every adapter previews identically. */
export function renderPreview(plan: SyncPlan): SyncPreview {
  return {
    subjectId: plan.subjectId,
    ops: plan.ops.map((op) => ({
      kind: op.kind,
      summary: summarizeOp(op),
      taskCount: op.tasks.length,
    })),
  };
}

function summarizeOp(op: SyncOp): string {
  if (op.kind === 'create_project') {
    return `create project "${op.project.name}" in ${op.project.pipeline}/${op.project.pipelineStage} with ${op.tasks.length} task(s)`;
  }
  return `update project ${op.projectId} (${Object.keys(op.project).length} field(s)) with ${op.tasks.length} task(s)`;
}

/**
 * In-memory adapter. Generates stable, sequential ids and records applied ops so
 * tests can assert on them. Never touches the network.
 */
export class InMemoryHubSpotClient implements HubSpotClient {
  readonly applied: SyncPlan[] = [];
  private seq = 0;
  constructor(private readonly owners: OwnerRef[] = []) {}

  async resolveOwner(query: OwnerQuery): Promise<OwnerRef | null> {
    return (
      this.owners.find(
        (o) => (query.email && o.email === query.email) || (query.name && o.ownerId === query.name),
      ) ?? null
    );
  }

  async preview(plan: SyncPlan): Promise<SyncPreview> {
    return renderPreview(plan);
  }

  async apply(plan: SyncPlan): Promise<SyncResult> {
    this.applied.push(plan);
    return {
      subjectId: plan.subjectId,
      refs: plan.ops.map((op) => {
        const projectId = op.kind === 'update_project' ? op.projectId : this.id('project');
        return {
          kind: op.kind,
          projectId,
          taskIds: op.tasks.map(() => this.id('task')),
        };
      }),
    };
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }
}
