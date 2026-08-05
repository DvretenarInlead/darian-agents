import type { OwnerQuery, OwnerRef, SyncPlan, SyncPreview, SyncResult, SyncOp, TaskInput, TaskSummary } from './types.js';

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
 * Direct task operations for the owner-facing assistant/MCP surface. These are
 * HUMAN-initiated actions (authenticated owner commands), so they bypass the
 * board but never the kill-switch or the audit log — callers enforce both.
 */
export interface HubSpotTaskOps {
  listTasks(limit: number): Promise<TaskSummary[]>;
  createTask(task: TaskInput): Promise<{ id: string }>;
  /** Attach a note to a task. `nowIso` is injected for audit determinism. */
  commentOnTask(taskId: string, comment: string, nowIso: string): Promise<{ id: string }>;
}

/** Deterministic in-memory task ops for tests/local runs. */
export class InMemoryTaskOps implements HubSpotTaskOps {
  readonly tasks: (TaskSummary & { comments: string[] })[] = [];
  private seq = 0;

  async listTasks(limit: number): Promise<TaskSummary[]> {
    return this.tasks.slice(0, limit).map(({ comments: _c, ...t }) => t);
  }

  async createTask(task: TaskInput): Promise<{ id: string }> {
    this.seq += 1;
    const id = `task-${this.seq}`;
    this.tasks.unshift({
      id,
      title: task.title,
      status: task.status ?? 'NOT_STARTED',
      dueDate: task.dueDate ?? null,
      body: task.body ?? null,
      comments: [],
    });
    return { id };
  }

  async commentOnTask(taskId: string, comment: string, _nowIso: string): Promise<{ id: string }> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`no such task: ${taskId}`);
    task.comments.push(comment);
    this.seq += 1;
    return { id: `note-${this.seq}` };
  }
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
