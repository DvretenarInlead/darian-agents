import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createMcpRoutes } from './mcp.js';
import { StubLlmClient } from '../integrations/anthropic/client.js';
import { InMemoryTaskOps } from '../integrations/hubspot/client.js';
import type { AuditEvent } from '../core/audit/writer.js';

const TOKEN = 'mcp-test-token-123456';

function stubPool(rows: Record<string, unknown>[] = []): Pool {
  return { query: async () => ({ rows }) } as unknown as Pool;
}

interface BuildOpts {
  audited?: AuditEvent[];
  taskOps?: InMemoryTaskOps;
  frozen?: boolean;
}

async function buildApp(overrides: BuildOpts = {}): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(
    createMcpRoutes({
      pool: stubPool(),
      llm: new StubLlmClient(() => 'Nothing urgent today.'),
      accessToken: TOKEN,
      ...(overrides.taskOps ? { taskOps: overrides.taskOps } : {}),
      nowMs: () => 1_700_000_000_000,
      nowIso: () => '2026-08-05T12:00:00.000Z',
      audit: async (event) => {
        (overrides.audited ?? []).push(event);
      },
      frozen: async () => overrides.frozen ?? false,
    }),
  );
  await app.ready();
  return app;
}

let nextId = 0;
function rpc(app: FastifyInstance, method: string, params?: Record<string, unknown>, token: string | null = TOKEN) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: { jsonrpc: '2.0', id: ++nextId, method, ...(params ? { params } : {}) },
  });
}

describe('MCP server', () => {
  it('completes the initialize handshake', async () => {
    const app = await buildApp();
    const res = await rpc(app, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.serverInfo.name).toBe('darian-agents');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('rejects missing/wrong tokens (401)', async () => {
    const app = await buildApp();
    expect((await rpc(app, 'tools/list', undefined, null)).statusCode).toBe(401);
    expect((await rpc(app, 'tools/list', undefined, 'wrong-token-aaaaaaaa')).statusCode).toBe(401);
  });

  it('acknowledges notifications without a body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(res.statusCode).toBe(202);
  });

  it('lists the expected tools', async () => {
    const app = await buildApp();
    const body = (await rpc(app, 'tools/list')).json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      'ask_assistant',
      'list_commitments',
      'pending_escalations',
      'list_tasks',
      'create_task',
      'comment_on_task',
    ]);
  });

  it('answers ask_assistant and audits the call as a read', async () => {
    const audited: AuditEvent[] = [];
    const app = await buildApp({ audited });
    const body = (
      await rpc(app, 'tools/call', { name: 'ask_assistant', arguments: { question: 'priority today?' } })
    ).json();

    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text).answer).toBe('Nothing urgent today.');
    expect(audited).toHaveLength(1);
    expect(audited[0]!.eventType).toBe('ingest');
    expect(audited[0]!.actorId).toBe('mcp');
  });

  it('creates and lists tasks through task ops, auditing writes as external_write', async () => {
    const audited: AuditEvent[] = [];
    const taskOps = new InMemoryTaskOps();
    const app = await buildApp({ audited, taskOps });

    const created = (
      await rpc(app, 'tools/call', {
        name: 'create_task',
        arguments: { title: 'Send proposal to client X', notes: 'from voice command' },
      })
    ).json();
    expect(created.result.isError).toBe(false);
    expect(JSON.parse(created.result.content[0].text).title).toBe('Send proposal to client X');
    expect(audited[0]!.eventType).toBe('external_write');

    const listed = (await rpc(app, 'tools/call', { name: 'list_tasks', arguments: {} })).json();
    const tasks = JSON.parse(listed.result.content[0].text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Send proposal to client X');

    const commented = (
      await rpc(app, 'tools/call', { name: 'comment_on_task', arguments: { taskId: tasks[0].id, comment: 'done?' } })
    ).json();
    expect(commented.result.isError).toBe(false);
    expect(taskOps.tasks[0]!.comments).toEqual(['done?']);
  });

  it('blocks writes while the kill-switch is engaged, reads still work', async () => {
    const taskOps = new InMemoryTaskOps();
    await taskOps.createTask({ title: 'pre-existing' });
    const app = await buildApp({ taskOps, frozen: true });

    const write = (
      await rpc(app, 'tools/call', { name: 'create_task', arguments: { title: 'should be blocked' } })
    ).json();
    expect(write.result.isError).toBe(true);
    expect(write.result.content[0].text).toMatch(/kill-switch/);

    const read = (await rpc(app, 'tools/call', { name: 'list_tasks', arguments: {} })).json();
    expect(read.result.isError).toBe(false);
  });

  it('reports task tools unconfigured without HubSpot', async () => {
    const app = await buildApp();
    const body = (await rpc(app, 'tools/call', { name: 'list_tasks', arguments: {} })).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not configured/);
  });

  it('rejects unknown methods and malformed requests', async () => {
    const app = await buildApp();
    expect((await rpc(app, 'resources/list')).json().error.code).toBe(-32601);

    const bad = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      payload: { id: 1, method: 'tools/list' }, // missing jsonrpc
    });
    expect(bad.statusCode).toBe(400);
  });
});
