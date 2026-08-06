import { describe, it, expect } from 'vitest';
import { HubSpotMcpTaskOps, type ToolCaller } from './mcpTaskOps.js';

/** Scripted ToolCaller: canned response per tool name, records every call. */
class StubCaller implements ToolCaller {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(private readonly responses: Record<string, string | ((args: Record<string, unknown>) => string)>) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    this.calls.push({ name, args });
    const r = this.responses[name];
    if (r === undefined) throw new Error(`no stub for ${name}`);
    return typeof r === 'function' ? r(args) : r;
  }
}

const USER_DETAILS = JSON.stringify({ userId: 1, ownerId: '4242', hubId: 999 });

describe('HubSpotMcpTaskOps', () => {
  it('lists tasks via hubspot-list-objects and maps properties', async () => {
    const caller = new StubCaller({
      'hubspot-list-objects': JSON.stringify({
        objects: [
          { id: 101, properties: { hs_task_subject: 'Send proposal', hs_task_status: 'NOT_STARTED', hs_timestamp: '2026-08-08', hs_task_body: 'ctx' } },
          { id: 102, properties: {} },
        ],
      }),
    });
    const ops = new HubSpotMcpTaskOps(caller);

    const tasks = await ops.listTasks(10);
    expect(tasks).toEqual([
      { id: '101', title: 'Send proposal', status: 'NOT_STARTED', dueDate: '2026-08-08', body: 'ctx' },
      { id: '102', title: '(untitled)', status: null, dueDate: null, body: null },
    ]);
    expect(caller.calls[0]!.args.objectType).toBe('tasks');
  });

  it('creates a task via create-engagement with a cached ownerId', async () => {
    const caller = new StubCaller({
      'hubspot-get-user-details': USER_DETAILS,
      'hubspot-create-engagement': JSON.stringify({ engagement: { id: 555 } }),
    });
    const ops = new HubSpotMcpTaskOps(caller);

    const created = await ops.createTask({ title: 'Send proposal', body: 'to X', dueDate: '2026-08-08' });
    expect(created).toEqual({ id: '555' });

    const create = caller.calls.find((c) => c.name === 'hubspot-create-engagement')!;
    expect(create.args.type).toBe('TASK');
    expect(create.args.ownerId).toBe(4242);
    expect(create.args.timestamp).toBe(Date.parse('2026-08-08'));
    expect((create.args.metadata as Record<string, unknown>).subject).toBe('Send proposal');

    // Second create must reuse the cached ownerId (no second user-details call).
    await ops.createTask({ title: 'Another' });
    expect(caller.calls.filter((c) => c.name === 'hubspot-get-user-details')).toHaveLength(1);
  });

  it('comments by appending a stamped line to the task body', async () => {
    const caller = new StubCaller({
      'hubspot-get-engagement': JSON.stringify({ engagement: { id: 101 }, metadata: { subject: 'T', body: 'original' } }),
      'hubspot-update-engagement': JSON.stringify({ ok: true }),
    });
    const ops = new HubSpotMcpTaskOps(caller);

    const res = await ops.commentOnTask('101', 'done?', '2026-08-06T12:00:00.000Z');
    expect(res).toEqual({ id: '101' });
    const update = caller.calls.find((c) => c.name === 'hubspot-update-engagement')!;
    expect(update.args.engagementId).toBe(101);
    expect((update.args.metadata as Record<string, unknown>).body).toBe('original\n\n[comment 2026-08-06] done?');
  });

  it('rejects non-numeric task ids and missing ownerId clearly', async () => {
    const ops = new HubSpotMcpTaskOps(new StubCaller({ 'hubspot-get-user-details': JSON.stringify({ userId: 1 }) }));
    await expect(ops.commentOnTask('abc', 'x', '2026-08-06T12:00:00Z')).rejects.toThrow(/numeric/);
    await expect(ops.createTask({ title: 'T' })).rejects.toThrow(/ownerId/);
  });

  it('surfaces unparseable tool payloads with context', async () => {
    const ops = new HubSpotMcpTaskOps(new StubCaller({ 'hubspot-list-objects': 'Error: something exploded' }));
    await expect(ops.listTasks(5)).rejects.toThrow(/unparseable list-objects/);
  });
});
