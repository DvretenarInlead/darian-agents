import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { assertEgressAllowed, getScopedSecret, EGRESS_HOSTS } from '../../core/governance/credentials.js';
import { McpStdioClient } from '../../core/net/mcpStdioClient.js';
import type { HubSpotTaskOps } from './client.js';
import type { TaskInput, TaskSummary } from './types.js';

/**
 * HubSpotTaskOps over HubSpot's OFFICIAL MCP server (@hubspot/mcp-server),
 * run as a managed stdio subprocess with the private-app token — the headless
 * path HubSpot supports (their remote mcp.hubspot.com is OAuth-PKCE-only).
 *
 * Tool mapping:
 *  - listTasks      → hubspot-list-objects (objectType 'tasks')
 *  - createTask     → hubspot-create-engagement (type TASK; ownerId from
 *                     hubspot-get-user-details, cached; dueDate → timestamp)
 *  - commentOnTask  → hubspot-get-engagement + hubspot-update-engagement
 *                     (their engagement surface has no note→task association,
 *                     so a comment is appended to the task body, timestamped)
 *
 * Governance is unchanged: the token is resolved through the hubspot_admin
 * scope and egress is asserted when the subprocess is created; callers keep
 * enforcing the kill-switch + audit exactly as with the direct adapter.
 */

/** Narrow caller interface so tests can stub the subprocess entirely. */
export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

const HOST = EGRESS_HOSTS.hubspotAccess; // api.hubapi.com — where the subprocess talks

function resolveServerEntry(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@hubspot/mcp-server/package.json');
  return join(dirname(pkg), 'dist', 'index.js');
}

/** Parse the JSON payload MCP tools return as text. */
function parseJson(text: string, context: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`hubspot-mcp: unparseable ${context} response: ${text.slice(0, 200)}`);
  }
}

export class HubSpotMcpTaskOps implements HubSpotTaskOps {
  private readonly client: ToolCaller;
  private cachedOwnerId: number | null = null;

  constructor(client?: ToolCaller) {
    if (client) {
      this.client = client;
    } else {
      assertEgressAllowed('hubspot_admin', HOST);
      const token = getScopedSecret('hubspot_admin', 'hubspotAccess');
      this.client = new McpStdioClient({
        command: process.execPath,
        args: [resolveServerEntry()],
        env: { PRIVATE_APP_ACCESS_TOKEN: token },
        name: 'hubspot-mcp',
      });
    }
  }

  private async ownerId(): Promise<number> {
    if (this.cachedOwnerId !== null) return this.cachedOwnerId;
    const data = parseJson(await this.client.callTool('hubspot-get-user-details', {}), 'user-details');
    const raw = (data.ownerId ?? (data.user as Record<string, unknown> | undefined)?.ownerId) as
      | string
      | number
      | undefined;
    const ownerId = Number(raw);
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      throw new Error('hubspot-mcp: could not resolve ownerId from hubspot-get-user-details');
    }
    this.cachedOwnerId = ownerId;
    return ownerId;
  }

  async listTasks(limit: number): Promise<TaskSummary[]> {
    const text = await this.client.callTool('hubspot-list-objects', {
      objectType: 'tasks',
      limit: Math.min(limit, 100),
      properties: ['hs_task_subject', 'hs_task_status', 'hs_timestamp', 'hs_task_body'],
    });
    const data = parseJson(text, 'list-objects');
    const rows = (data.objects ?? data.results ?? []) as Array<{
      id: string | number;
      properties?: Record<string, string | null>;
    }>;
    return rows.map((r) => ({
      id: String(r.id),
      title: r.properties?.hs_task_subject ?? '(untitled)',
      status: r.properties?.hs_task_status ?? null,
      dueDate: r.properties?.hs_timestamp ?? null,
      body: r.properties?.hs_task_body ?? null,
    }));
  }

  async createTask(task: TaskInput): Promise<{ id: string }> {
    const ownerId = await this.ownerId();
    const text = await this.client.callTool('hubspot-create-engagement', {
      type: 'TASK',
      ownerId,
      ...(task.dueDate ? { timestamp: Date.parse(task.dueDate) } : {}),
      associations: {},
      metadata: {
        subject: task.title,
        body: task.body ?? '',
        status: task.status ?? 'NOT_STARTED',
        forObjectType: 'CONTACT',
      },
    });
    const data = parseJson(text, 'create-engagement');
    const id = (data.engagement as Record<string, unknown> | undefined)?.id ?? data.id;
    if (id === undefined || id === null) throw new Error('hubspot-mcp: create-engagement returned no id');
    return { id: String(id) };
  }

  async commentOnTask(taskId: string, comment: string, nowIso: string): Promise<{ id: string }> {
    const engagementId = Number(taskId);
    if (!Number.isInteger(engagementId) || engagementId <= 0) {
      throw new Error(`hubspot-mcp: task id must be numeric, got '${taskId}'`);
    }
    const current = parseJson(
      await this.client.callTool('hubspot-get-engagement', { engagementId }),
      'get-engagement',
    );
    const metadata = (current.metadata ?? {}) as Record<string, unknown>;
    const existingBody = typeof metadata.body === 'string' ? metadata.body : '';
    const stamped = `${existingBody ? existingBody + '\n\n' : ''}[comment ${nowIso.slice(0, 10)}] ${comment}`;
    await this.client.callTool('hubspot-update-engagement', {
      engagementId,
      associations: {},
      metadata: { ...metadata, body: stamped },
    });
    return { id: taskId };
  }
}
