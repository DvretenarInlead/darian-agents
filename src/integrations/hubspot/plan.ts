import type { ProjectInput, SyncPlan, TaskInput } from './types.js';

/**
 * Build a HubSpot sync plan from board-approved, reconciled items (build-order
 * step 5). Pure — no I/O — so the create-or-update / no-duplicates logic is
 * fully unit-testable (this is "core, not afterthought" per the brief).
 *
 * Reconciliation runs upstream and tags each item; here we only translate
 * decisions into mutations:
 *  - `skipped_duplicate` items are dropped (never re-created).
 *  - If the meeting already maps to a project, we emit a single update op
 *    carrying the new/changed tasks; otherwise a create op.
 *  - If nothing new survives reconciliation, the plan has zero ops and the
 *    caller skips the sync entirely.
 */

export type ItemDecision = 'created' | 'updated' | 'skipped_duplicate';

export interface ApprovedItem {
  task: TaskInput;
  decision: ItemDecision;
}

export interface PlanInput {
  subjectId: string;
  project: ProjectInput;
  /** Set when reconciliation matched an existing HubSpot project for this meeting. */
  existingProjectId?: string;
  /** Optional changed project fields to apply on update. */
  projectUpdates?: Partial<ProjectInput>;
  items: ApprovedItem[];
}

export function buildSyncPlan(input: PlanInput): SyncPlan {
  const tasks = input.items.filter((i) => i.decision !== 'skipped_duplicate').map((i) => i.task);

  // For an existing project we may still have project-field updates even with no
  // new tasks; for a new project, no surviving tasks means nothing to create.
  if (input.existingProjectId) {
    const updates = input.projectUpdates ?? {};
    if (tasks.length === 0 && Object.keys(updates).length === 0) {
      return { subjectId: input.subjectId, ops: [] };
    }
    return {
      subjectId: input.subjectId,
      ops: [{ kind: 'update_project', projectId: input.existingProjectId, project: updates, tasks }],
    };
  }

  if (tasks.length === 0) {
    return { subjectId: input.subjectId, ops: [] };
  }
  return {
    subjectId: input.subjectId,
    ops: [{ kind: 'create_project', project: input.project, tasks }],
  };
}
