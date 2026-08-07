import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { hashToken, verifyToken } from '../console/auth/session.js';
import { InMemoryRateLimiter, type RateLimiter } from '../core/triggers/rateLimiter.js';
import { appendAudit, type AuditEvent } from '../core/audit/writer.js';
import { isEngaged } from '../console/killswitch.js';
import { sanitize } from '../core/agents/sanitize.js';
import type { LlmClient } from '../integrations/anthropic/client.js';
import type { HubSpotProjectOps, HubSpotTaskOps } from '../integrations/hubspot/client.js';
import { loadSyncRules } from '../products/meeting/rules.js';
import { askAssistant, QUESTION_MAX, type AssistantDeps } from '../products/meeting/assistant.js';
import { listCommitments } from '../products/meeting/query.js';

/**
 * darian-agents as an MCP server (Streamable HTTP, stateless) at POST /mcp —
 * so Claude (claude.ai custom connector, Claude Desktop, any MCP client) can
 * talk to the platform directly: ask the assistant, read the ledger, and work
 * with HubSpot tasks.
 *
 * Governance posture:
 *  - Bearer token (MCP_ACCESS_TOKEN, constant-time compare) + per-IP rate
 *    limit. Deliberately NOT behind the assistant IP allowlist — MCP clients
 *    connect from their own clouds; the token is the credential.
 *  - Reads are free; WRITES (create_task, comment_on_task) are human-initiated
 *    owner commands: they bypass the review board by design but never the
 *    kill-switch, and every call — read or write — lands in the audit chain.
 *  - Tool inputs are untrusted text: sanitized and length-capped before use.
 */

const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'ask_assistant',
    description:
      'Ask the personal assistant a question. Answers are grounded in the commitments ledger (action items captured from meetings, with reconciliation decisions and HubSpot references).',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: { question: { type: 'string', maxLength: QUESTION_MAX } },
    },
  },
  {
    name: 'list_commitments',
    description: 'List recent rows from the commitments ledger (provenance store), newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, maximum: 100 } },
    },
  },
  {
    name: 'pending_escalations',
    description: 'List items the review board escalated for human approval (pending only).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tasks',
    description: 'List recent HubSpot tasks (id, title, status, due date).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, maximum: 100 } },
    },
  },
  {
    name: 'create_task',
    description: 'Create a HubSpot task. Owner-initiated write: audited, blocked while the kill-switch is engaged.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', maxLength: 500 },
        notes: { type: 'string', maxLength: 4000 },
        dueDate: { type: 'string', description: 'ISO date/datetime' },
      },
    },
  },
  {
    name: 'comment_on_task',
    description: 'Attach a comment (note) to an existing HubSpot task by id. Audited; kill-switch gated.',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'comment'],
      properties: {
        taskId: { type: 'string', maxLength: 64 },
        comment: { type: 'string', maxLength: 4000 },
      },
    },
  },
  {
    name: 'list_projects',
    description: 'List recent HubSpot projects (id, name, pipeline, stage, status).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, maximum: 50 } },
    },
  },
  {
    name: 'list_project_tasks',
    description: 'List tasks associated with one HubSpot project by id.',
    inputSchema: {
      type: 'object',
      required: ['projectId'],
      properties: {
        projectId: { type: 'string', maxLength: 64 },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'create_project',
    description:
      'Create a HubSpot project (pipeline/stage from configured sync rules). Owner-initiated write: audited, kill-switch gated.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', maxLength: 200 },
        description: { type: 'string', maxLength: 2000 },
      },
    },
  },
  {
    name: 'create_task_in_project',
    description: 'Create a HubSpot task inside a project (associated to it). Audited; kill-switch gated.',
    inputSchema: {
      type: 'object',
      required: ['projectId', 'title'],
      properties: {
        projectId: { type: 'string', maxLength: 64 },
        title: { type: 'string', maxLength: 500 },
        notes: { type: 'string', maxLength: 4000 },
        dueDate: { type: 'string', description: 'ISO date/datetime' },
      },
    },
  },
] as const;

export interface McpRoutesOptions {
  pool: Pool;
  llm: LlmClient;
  /** Fast model for ask_assistant (same override the HUD uses). */
  model?: string;
  /** HubSpot task operations; task tools report unconfigured without it. */
  taskOps?: HubSpotTaskOps;
  /** HubSpot project operations (direct adapter); project tools report unconfigured without it. */
  projectOps?: HubSpotProjectOps;
  /** Read-only Fireflies lookup tools for ask_assistant; omit → ledger-only. */
  fireflies?: AssistantDeps['fireflies'];
  /** Loads the console-editable skill block for ask_assistant. */
  loadSkill?: () => Promise<string>;
  /** Loads the operator tool policy (disabled tool names). */
  loadToolPolicy?: () => Promise<string[]>;
  /** Shared secret MCP clients present as `Authorization: Bearer <token>`. */
  accessToken: string;
  rateLimit?: { windowMs: number; max: number };
  limiter?: RateLimiter;
  nowMs?: () => number;
  nowIso?: () => string;
  /** Injectable for tests. */
  audit?: (event: AuditEvent, nowIso: string) => Promise<unknown>;
  frozen?: () => Promise<boolean>;
}

export function createMcpRoutes(opts: McpRoutesOptions): FastifyPluginAsync {
  const limiter = opts.limiter ?? new InMemoryRateLimiter(opts.rateLimit ?? { windowMs: 60_000, max: 60 });
  const nowMs = opts.nowMs ?? (() => Date.now());
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const audit = opts.audit ?? ((event: AuditEvent, at: string) => appendAudit(opts.pool, event, at));
  const frozen = opts.frozen ?? (() => isEngaged(opts.pool));
  const tokenHash = hashToken(opts.accessToken);

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'ask_assistant': {
        const question = sanitize(String(args.question ?? ''), { maxLength: QUESTION_MAX });
        const skillPrompt = opts.loadSkill ? await opts.loadSkill() : undefined;
        const result = await askAssistant(
          {
            pool: opts.pool,
            llm: opts.llm,
            ...(skillPrompt ? { skillPrompt } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.fireflies ? { fireflies: opts.fireflies } : {}),
            ...(opts.taskOps ? { taskOps: opts.taskOps } : {}),
          },
          question,
        );
        return { answer: result.answer, refused: result.flagged.length > 0, toolCalls: result.toolCalls };
      }
      case 'list_commitments': {
        const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 100);
        return listCommitments(opts.pool, { limit });
      }
      case 'pending_escalations': {
        const { rows } = await opts.pool.query<{
          id: string;
          product: string;
          subject_id: string;
          reason: string;
          created_at: string;
        }>(`SELECT id, product, subject_id, reason, created_at FROM escalation_queue WHERE status='pending' ORDER BY created_at LIMIT 100`);
        return rows;
      }
      case 'list_tasks': {
        if (!opts.taskOps) throw new Error('HubSpot is not configured (HUBSPOT_ACCESS_TOKEN missing)');
        const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 100);
        return opts.taskOps.listTasks(limit);
      }
      case 'create_task': {
        if (!opts.taskOps) throw new Error('HubSpot is not configured (HUBSPOT_ACCESS_TOKEN missing)');
        if (await frozen()) throw new Error('external writes are frozen by the incident kill-switch');
        const title = sanitize(String(args.title ?? ''), { maxLength: 500 }).trim();
        if (!title) throw new Error('title is required');
        const notes = args.notes ? sanitize(String(args.notes), { maxLength: 4000 }) : undefined;
        const created = await opts.taskOps.createTask({
          title,
          ...(notes ? { body: notes } : {}),
          ...(args.dueDate ? { dueDate: String(args.dueDate) } : {}),
        });
        return { id: created.id, title };
      }
      case 'comment_on_task': {
        if (!opts.taskOps) throw new Error('HubSpot is not configured (HUBSPOT_ACCESS_TOKEN missing)');
        if (await frozen()) throw new Error('external writes are frozen by the incident kill-switch');
        const taskId = sanitize(String(args.taskId ?? ''), { maxLength: 64 }).trim();
        const comment = sanitize(String(args.comment ?? ''), { maxLength: 4000 }).trim();
        if (!taskId || !comment) throw new Error('taskId and comment are required');
        const note = await opts.taskOps.commentOnTask(taskId, comment, nowIso());
        return { noteId: note.id, taskId };
      }
      case 'list_projects': {
        if (!opts.projectOps) throw new Error('HubSpot is not configured (HUBSPOT_ACCESS_TOKEN missing)');
        const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 50);
        return opts.projectOps.listProjects(limit);
      }
      case 'list_project_tasks': {
        if (!opts.projectOps) throw new Error('HubSpot is not configured (HUBSPOT_ACCESS_TOKEN missing)');
        const projectId = sanitize(String(args.projectId ?? ''), { maxLength: 64 }).trim();
        if (!projectId) throw new Error('projectId is required');
        const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 50);
        return opts.projectOps.listProjectTasks(projectId, limit);
      }
      case 'create_project': {
        if (!opts.projectOps) throw new Error('HubSpot is not configured (HUBSPOT_ACCESS_TOKEN missing)');
        if (await frozen()) throw new Error('external writes are frozen by the incident kill-switch');
        const projectName = sanitize(String(args.name ?? ''), { maxLength: 200 }).trim();
        if (!projectName) throw new Error('name is required');
        const rules = await loadSyncRules(opts.pool, { pipeline: 'default', pipelineStage: 'new' });
        const description = args.description ? sanitize(String(args.description), { maxLength: 2000 }) : undefined;
        const created = await opts.projectOps.createProject({
          name: projectName,
          pipeline: rules.project.pipeline,
          pipelineStage: rules.project.pipelineStage,
          ...(rules.project.type ? { type: rules.project.type } : {}),
          ...(description ? { description } : {}),
        });
        return { id: created.id, name: projectName };
      }
      case 'create_task_in_project': {
        if (!opts.projectOps) throw new Error('HubSpot is not configured (HUBSPOT_ACCESS_TOKEN missing)');
        if (await frozen()) throw new Error('external writes are frozen by the incident kill-switch');
        const projectId = sanitize(String(args.projectId ?? ''), { maxLength: 64 }).trim();
        const title = sanitize(String(args.title ?? ''), { maxLength: 500 }).trim();
        if (!projectId || !title) throw new Error('projectId and title are required');
        const notes = args.notes ? sanitize(String(args.notes), { maxLength: 4000 }) : undefined;
        const created = await opts.projectOps.createTaskInProject(projectId, {
          title,
          ...(notes ? { body: notes } : {}),
          ...(args.dueDate ? { dueDate: String(args.dueDate) } : {}),
        });
        return { id: created.id, projectId, title };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  const WRITE_TOOLS = new Set(['create_task', 'comment_on_task', 'create_project', 'create_task_in_project']);

  const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    // Stateless Streamable HTTP: no SSE stream to resume.
    app.get('/mcp', async (_req, reply) => reply.code(405).send({ error: 'method_not_allowed' }));

    app.post('/mcp', async (req, reply) => {
      const rl = await limiter.consume([`mcp:ip:${req.ip}`], nowMs());
      if (!rl.allowed) return reply.code(429).send({ error: 'rate_limited' });

      const auth = String(req.headers.authorization ?? '');
      const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (!presented || !verifyToken(presented, tokenHash)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const msg = req.body as JsonRpcRequest;
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
        return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
      }

      // Notifications (no id) are acknowledged without a body.
      if (msg.id === undefined || msg.id === null) {
        if (typeof msg.method === 'string' && msg.method.startsWith('notifications/')) {
          return reply.code(202).send();
        }
        return reply.code(202).send();
      }

      const respond = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
      const respondError = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

      switch (msg.method) {
        case 'initialize':
          return respond({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'darian-agents', version: '1.0.0' },
          });
        case 'ping':
          return respond({});
        case 'tools/list': {
          const disabled = new Set(opts.loadToolPolicy ? await opts.loadToolPolicy() : []);
          return respond({ tools: TOOLS.filter((t) => !disabled.has(t.name)) });
        }
        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
          const disabled = opts.loadToolPolicy ? await opts.loadToolPolicy() : [];
          if (disabled.includes(name)) {
            return respond({
              content: [{ type: 'text', text: `tool '${name}' is disabled by the operator (console → Skills)` }],
              isError: true,
            });
          }
          try {
            const result = await callTool(name, args);
            await audit(
              {
                eventType: WRITE_TOOLS.has(name) ? 'external_write' : 'ingest',
                product: 'meeting',
                actorId: 'mcp',
                subjectId: name,
                payload: { kind: 'mcp_tool_call', tool: name, args, result },
              },
              nowIso(),
            );
            return respond({
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              isError: false,
            });
          } catch (err) {
            req.log.warn({ tool: name, err: String(err) }, 'mcp tool call failed');
            return respond({
              content: [{ type: 'text', text: String(err instanceof Error ? err.message : err) }],
              isError: true,
            });
          }
        }
        default:
          return respondError(-32601, `method not found: ${String(msg.method)}`);
      }
    });
  };

  return plugin;
}
