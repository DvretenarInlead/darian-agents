import { config } from '../../config/index.js';
import { assertEgressAllowed, getScopedSecret, EGRESS_HOSTS } from '../../core/governance/credentials.js';
import { resilientFetch } from '../../core/net/resilientFetch.js';
import { renderPreview, type HubSpotClient, type HubSpotProjectOps, type HubSpotTaskOps } from './client.js';
import type {
  OwnerQuery,
  OwnerRef,
  ProjectInput,
  ProjectSummary,
  SyncOp,
  SyncPlan,
  SyncPreview,
  SyncResult,
  SyncedRef,
  TaskInput,
  TaskSummary,
} from './types.js';

/**
 * Version-pinned Projects API adapter — the documented fallback when the Agent
 * CLI is unavailable (build-order step 5).
 *
 * NOTE: endpoint paths and association type ids below follow the brief's pinned
 * `/crm/objects/<version>/projects` base; the exact association category/typeId
 * and any required scopes must be confirmed against the provisioned Hub (one of
 * the brief's open "remaining confirmations"). The structure — version pinning,
 * egress enforcement, admin-mode owner resolution via the service key — is
 * final; only the HubSpot-side specifics are pending verification.
 */
const HOST = EGRESS_HOSTS.hubspotAccess; // api.hubapi.com
const BASE = `https://${HOST}`;

function projectToProperties(p: Partial<ProjectInput>): Record<string, string> {
  const props: Record<string, string> = {};
  if (p.name !== undefined) props.hs_name = p.name;
  if (p.pipeline !== undefined) props.hs_pipeline = p.pipeline;
  if (p.pipelineStage !== undefined) props.hs_pipeline_stage = p.pipelineStage;
  if (p.description !== undefined) props.hs_description = p.description;
  if (p.status !== undefined) props.hs_status = p.status;
  if (p.targetDueDate !== undefined) props.hs_target_due_date = p.targetDueDate;
  if (p.type !== undefined) props.hs_type = p.type;
  if (p.ownerId !== undefined) props.hubspot_owner_id = p.ownerId;
  return props;
}

/**
 * HubSpot object ids are numeric. Ids that reach the direct adapter from the
 * assistant/MCP surfaces are caller-supplied, so refuse anything else before
 * it is interpolated into a request path (the MCP adapter does the same).
 */
function assertObjectId(kind: string, id: string): string {
  if (!/^\d{1,20}$/.test(id)) throw new Error(`invalid HubSpot ${kind} id`);
  return id;
}

function taskToProperties(t: TaskInput): Record<string, string> {
  const props: Record<string, string> = { hs_task_subject: t.title };
  if (t.body !== undefined) props.hs_task_body = t.body;
  if (t.dueDate !== undefined) props.hs_timestamp = t.dueDate;
  if (t.ownerId !== undefined) props.hubspot_owner_id = t.ownerId;
  if (t.status !== undefined) props.hs_task_status = t.status;
  return props;
}

export class ProjectsApiHubSpotClient implements HubSpotClient, HubSpotTaskOps, HubSpotProjectOps {
  private get projectsPath(): string {
    return `/crm/objects/${config().hubspot.projectsApiVersion}/projects`;
  }

  private async http<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    assertEgressAllowed('hubspot_admin', HOST); // deny-by-default egress guard
    const res = await resilientFetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`HubSpot ${method} ${path} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  async resolveOwner(query: OwnerQuery): Promise<OwnerRef | null> {
    // Admin-mode: owner lookup uses the broad service key, scoped to hubspot_admin.
    const token = getScopedSecret('hubspot_admin', 'hubspotService');
    const params = query.email ? `?email=${encodeURIComponent(query.email)}` : '';
    const data = await this.http<{ results?: { id: string; email?: string }[] }>(
      'GET',
      `/crm/v3/owners${params}`,
      token,
    );
    const match = data.results?.[0];
    return match ? { ownerId: match.id, ...(match.email ? { email: match.email } : {}) } : null;
  }

  async preview(plan: SyncPlan): Promise<SyncPreview> {
    // Dry-run never touches the network.
    return renderPreview(plan);
  }

  async apply(plan: SyncPlan): Promise<SyncResult> {
    const token = getScopedSecret('hubspot_admin', 'hubspotAccess');
    const refs: SyncedRef[] = [];
    for (const op of plan.ops) {
      refs.push(await this.applyOp(op, token));
    }
    return { subjectId: plan.subjectId, refs };
  }

  // ---- Owner-facing project ops (assistant/MCP surface) ----
  // Human-initiated; callers enforce the kill-switch and audit.

  async listProjects(limit: number): Promise<ProjectSummary[]> {
    const token = getScopedSecret('hubspot_admin', 'hubspotAccess');
    const props = 'hs_name,hs_pipeline,hs_pipeline_stage,hs_status';
    const data = await this.http<{
      results?: Array<{ id: string; properties?: Record<string, string | null> }>;
    }>('GET', `${this.projectsPath}?limit=${Math.min(limit, 100)}&properties=${props}`, token);
    return (data.results ?? []).map((r) => ({
      id: r.id,
      name: r.properties?.hs_name ?? '(unnamed)',
      pipeline: r.properties?.hs_pipeline ?? null,
      pipelineStage: r.properties?.hs_pipeline_stage ?? null,
      status: r.properties?.hs_status ?? null,
    }));
  }

  async createProject(project: ProjectInput): Promise<{ id: string }> {
    const token = getScopedSecret('hubspot_admin', 'hubspotAccess');
    const created = await this.http<{ id: string }>('POST', this.projectsPath, token, {
      properties: projectToProperties(project),
    });
    return { id: created.id };
  }

  async createTaskInProject(projectId: string, task: TaskInput): Promise<{ id: string }> {
    assertObjectId('project', projectId);
    const token = getScopedSecret('hubspot_admin', 'hubspotAccess');
    const created = await this.http<{ id: string }>('POST', '/crm/v3/objects/tasks', token, {
      properties: taskToProperties(task),
    });
    await this.http('PUT', `/crm/v4/objects/tasks/${created.id}/associations/default/projects/${projectId}`, token);
    return { id: created.id };
  }

  async listProjectTasks(projectId: string, limit: number): Promise<TaskSummary[]> {
    assertObjectId('project', projectId);
    const token = getScopedSecret('hubspot_admin', 'hubspotAccess');
    const assoc = await this.http<{ results?: Array<{ toObjectId: string | number }> }>(
      'GET',
      `/crm/v4/objects/projects/${projectId}/associations/tasks?limit=${Math.min(limit, 100)}`,
      token,
    );
    const ids = (assoc.results ?? []).map((r) => String(r.toObjectId));
    if (ids.length === 0) return [];
    const batch = await this.http<{
      results?: Array<{ id: string; properties?: Record<string, string | null> }>;
    }>('POST', '/crm/v3/objects/tasks/batch/read', token, {
      properties: ['hs_task_subject', 'hs_task_status', 'hs_timestamp', 'hs_task_body'],
      inputs: ids.map((id) => ({ id })),
    });
    return (batch.results ?? []).map((r) => ({
      id: r.id,
      title: r.properties?.hs_task_subject ?? '(untitled)',
      status: r.properties?.hs_task_status ?? null,
      dueDate: r.properties?.hs_timestamp ?? null,
      body: r.properties?.hs_task_body ?? null,
    }));
  }

  // ---- Owner-facing task ops (assistant/MCP surface) ----
  // Human-initiated: callers enforce the kill-switch and audit; egress and
  // credentials remain scoped to hubspot_admin like every other HubSpot call.

  async listTasks(limit: number): Promise<TaskSummary[]> {
    const token = getScopedSecret('hubspot_admin', 'hubspotAccess');
    const props = 'hs_task_subject,hs_task_status,hs_timestamp,hs_task_body';
    const data = await this.http<{
      results?: Array<{ id: string; properties?: Record<string, string | null> }>;
    }>('GET', `/crm/v3/objects/tasks?limit=${Math.min(limit, 100)}&properties=${props}`, token);
    return (data.results ?? []).map((r) => ({
      id: r.id,
      title: r.properties?.hs_task_subject ?? '(untitled)',
      status: r.properties?.hs_task_status ?? null,
      dueDate: r.properties?.hs_timestamp ?? null,
      body: r.properties?.hs_task_body ?? null,
    }));
  }

  async createTask(task: TaskInput): Promise<{ id: string }> {
    const token = getScopedSecret('hubspot_admin', 'hubspotAccess');
    const created = await this.http<{ id: string }>('POST', '/crm/v3/objects/tasks', token, {
      properties: taskToProperties(task),
    });
    return { id: created.id };
  }

  async commentOnTask(taskId: string, comment: string, nowIso: string): Promise<{ id: string }> {
    assertObjectId('task', taskId);
    const token = getScopedSecret('hubspot_admin', 'hubspotAccess');
    const note = await this.http<{ id: string }>('POST', '/crm/v3/objects/notes', token, {
      properties: { hs_note_body: comment, hs_timestamp: nowIso },
    });
    await this.http('PUT', `/crm/v4/objects/notes/${note.id}/associations/default/tasks/${taskId}`, token);
    return { id: note.id };
  }

  private async applyOp(op: SyncOp, token: string): Promise<SyncedRef> {
    let projectId: string;
    if (op.kind === 'create_project') {
      const created = await this.http<{ id: string }>('POST', this.projectsPath, token, {
        properties: projectToProperties(op.project),
      });
      projectId = created.id;
    } else {
      await this.http('PATCH', `${this.projectsPath}/${op.projectId}`, token, {
        properties: projectToProperties(op.project),
      });
      projectId = op.projectId;
    }

    const taskIds: string[] = [];
    for (const task of op.tasks) {
      const createdTask = await this.http<{ id: string }>('POST', '/crm/v3/objects/tasks', token, {
        properties: taskToProperties(task),
      });
      taskIds.push(createdTask.id);
      // Associate task → project (association type pending Hub confirmation).
      await this.http(
        'PUT',
        `/crm/v4/objects/tasks/${createdTask.id}/associations/default/projects/${projectId}`,
        token,
      );
    }
    return { kind: op.kind, projectId, taskIds };
  }
}
