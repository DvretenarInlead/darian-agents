/**
 * HubSpot integration domain types (build-order step 5).
 *
 * Locked decisions from the brief:
 *  - Native **Projects object** + associated **Tasks** (not a custom-property hack).
 *  - Projects API base `/crm/objects/2026-03/projects` — version pinned.
 *  - Required project props: hs_name, hs_pipeline, hs_pipeline_stage.
 *  - HubSpot Agent CLI is primary; the version-pinned Projects API is the
 *    documented fallback.
 *
 * The rest of the platform talks to the `HubSpotClient` port (client.ts), never
 * to a concrete adapter — so the CLI's still-beta surface can change without
 * rippling outward, and tests run against an in-memory implementation.
 */

export interface ProjectInput {
  /** hs_name (required) */
  name: string;
  /** hs_pipeline (required) */
  pipeline: string;
  /** hs_pipeline_stage (required) */
  pipelineStage: string;
  description?: string; // hs_description
  status?: string; // hs_status
  targetDueDate?: string; // hs_target_due_date (ISO date)
  type?: string; // hs_type
  ownerId?: string; // hubspot_owner_id
}

export interface TaskInput {
  title: string;
  body?: string;
  dueDate?: string; // ISO date
  ownerId?: string;
  status?: string;
}

/** A single planned mutation. Reconciliation decides create vs update. */
export type SyncOp =
  | { kind: 'create_project'; project: ProjectInput; tasks: TaskInput[] }
  | { kind: 'update_project'; projectId: string; project: Partial<ProjectInput>; tasks: TaskInput[] };

export interface SyncPlan {
  subjectId: string; // e.g. meeting id
  ops: SyncOp[];
}

/** Human-readable description of what an op *would* do (dry-run preview). */
export interface PlannedOp {
  kind: SyncOp['kind'];
  summary: string;
  taskCount: number;
}

export interface SyncPreview {
  subjectId: string;
  ops: PlannedOp[];
}

export interface SyncedRef {
  kind: SyncOp['kind'];
  projectId: string;
  taskIds: string[];
}

export interface SyncResult {
  subjectId: string;
  refs: SyncedRef[];
}

export interface OwnerQuery {
  email?: string;
  name?: string;
}

export interface OwnerRef {
  ownerId: string;
  email?: string;
}
