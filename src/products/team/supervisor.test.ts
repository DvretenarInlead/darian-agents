import { describe, it, expect, vi } from 'vitest';
import { InMemoryManagedAgents, type RawSessionEvent } from '../../integrations/anthropic/managedAgents.js';
import type { AuditEvent } from '../../core/audit/writer.js';
import { InMemoryTeamStore } from './memoryStore.js';
import { createTeamSupervisor } from './supervisor.js';
import type { PendingAction, TeamGate, TeamRun } from './types.js';

const cfg = {
  enabled: true, lockfilePath: 'x', defaultBudgetCents: 1000, maxBudgetCents: 10000, approvalTtlHours: 24,
  streamIdleCloseMin: 30, firefliesVaultId: undefined, githubVaultId: undefined, workspaceId: undefined,
};
const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function setup(opts: { frozen?: boolean } = {}) {
  let clock = new Date('2026-10-26T12:00:00Z');
  const now = () => clock;
  const store = new InMemoryTeamStore(now);
  const client = new InMemoryManagedAgents();
  const audits: AuditEvent[] = [];
  const gate: TeamGate = {
    decide: vi.fn(), onNewAsk: vi.fn(async (_a: PendingAction) => {}),
    expireStale: vi.fn(async () => 0), enforceKillSwitch: vi.fn(async () => 0), reconcileStuck: vi.fn(async () => 0),
  };
  const state = { frozen: opts.frozen ?? false, stop: false };
  const supervisor = createTeamSupervisor({
    store, client, gate, cfg, now,
    audit: async (e) => { audits.push(e); },
    isWritesFrozen: async () => state.frozen,
    tickMs: 0,
    housekeepingMs: 60_000,
    sleep: tick,
  });
  const start = () => supervisor.run(() => state.stop);
  const stop = async (p: Promise<void>) => { state.stop = true; await p; };
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

  async function addRun(status: TeamRun['status'] = 'running'): Promise<{ run: TeamRun; sessionId: string }> {
    const s = await client.createSession({
      agentId: 'agent_test_pm', agentVersion: 1, environmentId: 'env_test', vaultIds: [], budgetCents: 1000, title: 't', metadata: {},
    });
    const row = await store.insertRun({
      agentSlug: 'project_manager', agentId: 'agent_test_pm', agentVersion: 1, environmentId: 'env_test',
      portalId: null, portalKind: 'sandbox', clientLabel: 'PYB', projectRef: null, task: 't', startedBy: null,
      trigger: 'console', budgetCents: 1000,
    });
    await store.attachSession(row.id, s.id, status);
    return { run: (await store.getRun(row.id)) as TeamRun, sessionId: s.id };
  }
  return { store, client, gate, audits, state, start, stop, advance, addRun };
}

const msg = (id: string): RawSessionEvent => ({ id, type: 'agent.message', content: [{ type: 'text', text: id }] });

describe('team supervisor', () => {
  it('opens one stream per streamable run and none for terminated runs', async () => {
    const t = setup();
    const a = await t.addRun('running');
    const b = await t.addRun('requires_action');
    const dead = await t.addRun('terminated');
    const p = t.start();
    await until(() => t.client.openStreamCount(a.sessionId) === 1 && t.client.openStreamCount(b.sessionId) === 1, 'streams');
    for (let i = 0; i < 5; i++) await tick(); // several more ticks must not add connections
    expect(t.client.openStreamCount(a.sessionId)).toBe(1);
    expect(t.client.openStreamCount(b.sessionId)).toBe(1);
    expect(t.client.openStreamCount(dead.sessionId)).toBe(0);
    await t.stop(p);
  });

  it('applies live events from an open stream', async () => {
    const t = setup();
    const a = await t.addRun();
    const p = t.start();
    await until(() => t.client.openStreamCount(a.sessionId) === 1, 'stream');
    t.client.emit(a.sessionId, msg('m1'));
    await until(() => t.store.seen.has('m1'), 'm1');
    expect(t.audits.some((e) => e.eventType === 'team_session')).toBe(true);
    await t.stop(p);
  });

  it('picks up events emitted during a stream gap after a drop, exactly once', async () => {
    const t = setup();
    const a = await t.addRun();
    const p = t.start();
    await until(() => t.client.openStreamCount(a.sessionId) === 1, 'stream');
    t.client.emit(a.sessionId, msg('live1'));
    await until(() => t.store.seen.has('live1'), 'live1');

    t.client.emit(a.sessionId, msg('gap1'), { historyOnly: true });
    t.client.emit(a.sessionId, msg('gap2'), { historyOnly: true });
    t.client.dropStreams(a.sessionId);
    await until(() => t.store.seen.has('gap1') && t.store.seen.has('gap2'), 'gap events');
    await until(() => t.client.openStreamCount(a.sessionId) === 1, 'reconnected');
    t.client.emit(a.sessionId, msg('live2'));
    await until(() => t.store.seen.has('live2'), 'live2');

    const ids = t.audits.filter((e) => e.eventType === 'team_session').map((e) => (e.payload as { eventId: string }).eventId);
    expect(ids).toEqual(['live1', 'gap1', 'gap2', 'live2']);
    await t.stop(p);
  });

  it('closes the stream when a run leaves the streamable set', async () => {
    const t = setup();
    const a = await t.addRun();
    const p = t.start();
    await until(() => t.client.openStreamCount(a.sessionId) === 1, 'stream');
    await t.store.updateRunState(a.run.id, { status: 'failed' });
    await until(() => t.client.openStreamCount(a.sessionId) === 0, 'stream closed');
    await t.stop(p);
  });

  it('stops streaming a run once its terminal event arrives', async () => {
    const t = setup();
    const a = await t.addRun();
    const p = t.start();
    await until(() => t.client.openStreamCount(a.sessionId) === 1, 'stream');
    t.client.emit(a.sessionId, { id: 'term', type: 'session.status_terminated' });
    await until(() => t.store.runs.get(a.run.id)!.status === 'terminated', 'terminated');
    await until(() => t.client.openStreamCount(a.sessionId) === 0, 'stream closed');
    await t.stop(p);
  });

  it('enforces the kill-switch only while writes are frozen', async () => {
    const t = setup();
    await t.addRun();
    const p = t.start();
    for (let i = 0; i < 5; i++) await tick();
    expect(t.gate.enforceKillSwitch).not.toHaveBeenCalled();
    t.state.frozen = true;
    await until(() => vi.mocked(t.gate.enforceKillSwitch).mock.calls.length >= 2, 'enforceKillSwitch each tick');
    t.state.frozen = false;
    await t.stop(p);
  });

  it('runs housekeeping on the first tick and then once per housekeeping interval', async () => {
    const t = setup();
    await t.addRun();
    const p = t.start();
    await until(() => vi.mocked(t.gate.expireStale).mock.calls.length === 1, 'first housekeeping');
    expect(t.gate.reconcileStuck).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) await tick();
    expect(t.gate.expireStale).toHaveBeenCalledTimes(1);

    t.advance(59_000);
    for (let i = 0; i < 3; i++) await tick();
    expect(t.gate.expireStale).toHaveBeenCalledTimes(1);
    t.advance(1_000);
    await until(() => vi.mocked(t.gate.expireStale).mock.calls.length === 2, 'second housekeeping');
    expect(t.gate.reconcileStuck).toHaveBeenCalledTimes(2);
    await t.stop(p);
  });

  it('repairs a missed terminal event from retrieveSession and refreshes cost', async () => {
    const t = setup();
    const a = await t.addRun();
    const ask = await t.store.insertPendingAction({
      runId: a.run.id, eventId: 'tu1', threadId: null, toolKind: 'mcp', toolName: 'x', mcpServer: null, input: {},
      inputTruncated: false, injectionFlags: [], portalId: null, portalKind: 'sandbox', expiresAt: new Date('2027-01-01'),
    });
    t.client.setSession(a.sessionId, { status: 'terminated', listCostCents: 321 });
    const p = t.start();
    await until(() => t.store.runs.get(a.run.id)!.status === 'terminated', 'terminated via housekeeping');
    expect(t.store.runs.get(a.run.id)!.listCostCents).toBe(321);
    expect(t.store.actions.get(ask.action.id)!.status).toBe('void');
    await t.stop(p);
  });

  it('treats a 404 from retrieveSession as terminated and voids pending asks', async () => {
    const t = setup();
    const a = await t.addRun();
    const ask = await t.store.insertPendingAction({
      runId: a.run.id, eventId: 'tu1', threadId: null, toolKind: 'mcp', toolName: 'x', mcpServer: null, input: {},
      inputTruncated: false, injectionFlags: [], portalId: null, portalKind: 'sandbox', expiresAt: new Date('2027-01-01'),
    });
    t.client.failNext('retrieveSession', Object.assign(new Error('not found'), { status: 404 }));
    const p = t.start();
    await until(() => t.store.runs.get(a.run.id)!.status === 'terminated', 'terminated via 404');
    expect(t.store.actions.get(ask.action.id)!.status).toBe('void');
    await t.stop(p);
  });

  it('survives a failing retrieveSession and keeps running', async () => {
    const t = setup();
    const a = await t.addRun();
    t.client.failNext('retrieveSession', new Error('429'));
    const p = t.start();
    await until(() => t.client.openStreamCount(a.sessionId) === 1, 'stream');
    await until(() => vi.mocked(t.gate.expireStale).mock.calls.length >= 1, 'housekeeping');
    await t.stop(p);
  });

  it('survives a failing store listing and recovers', async () => {
    const t = setup();
    const a = await t.addRun();
    const real = t.store.listStreamableRuns.bind(t.store);
    let fail = true;
    t.store.listStreamableRuns = async (c) => {
      if (fail) { fail = false; throw new Error('db down'); }
      return real(c);
    };
    const p = t.start();
    await until(() => t.client.openStreamCount(a.sessionId) === 1, 'stream after recovery');
    await t.stop(p);
  });

  it('returns promptly after stopped() and leaves no open streams', async () => {
    const t = setup();
    const a = await t.addRun();
    const b = await t.addRun();
    const p = t.start();
    await until(() => t.client.openStreamCount(a.sessionId) === 1 && t.client.openStreamCount(b.sessionId) === 1, 'streams');
    await t.stop(p);
    expect(t.client.openStreamCount(a.sessionId)).toBe(0);
    expect(t.client.openStreamCount(b.sessionId)).toBe(0);
  });

  it('returns at once when already stopped, without opening anything', async () => {
    const t = setup();
    const a = await t.addRun();
    t.state.stop = true;
    await t.start();
    expect(t.client.openStreamCount(a.sessionId)).toBe(0);
  });
});
