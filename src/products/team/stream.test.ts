import { describe, it, expect, vi } from 'vitest';
import { InMemoryManagedAgents, type RawSessionEvent } from '../../integrations/anthropic/managedAgents.js';
import type { AuditEvent } from '../../core/audit/writer.js';
import { InMemoryTeamStore } from './memoryStore.js';
import { backoffMs, runStream, type RunStreamDeps } from './stream.js';
import type { PendingAction, TeamGate, TeamRun } from './types.js';

const T0 = new Date('2026-10-26T12:00:00Z');
const cfg = {
  enabled: true, lockfilePath: 'x', defaultBudgetCents: 1000, maxBudgetCents: 10000, approvalTtlHours: 24,
  streamIdleCloseMin: 30, firefliesVaultId: undefined, githubVaultId: undefined, workspaceId: undefined,
};
const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function setup() {
  const store = new InMemoryTeamStore(() => T0);
  const client = new InMemoryManagedAgents();
  const audits: AuditEvent[] = [];
  const gate: TeamGate = {
    decide: vi.fn(), onNewAsk: vi.fn(async (_a: PendingAction) => {}),
    expireStale: vi.fn(async () => 0), enforceKillSwitch: vi.fn(async () => 0), reconcileStuck: vi.fn(async () => 0),
  };
  const sleeps: number[] = [];
  const deps: RunStreamDeps = {
    store, client, gate, cfg, now: () => T0,
    audit: async (e) => { audits.push(e); },
    sleep: async (ms) => { sleeps.push(ms); await tick(); },
  };
  const created = await client.createSession({
    agentId: 'agent_test_pm', agentVersion: 1, environmentId: 'env_test', vaultIds: [], budgetCents: 1000, title: 't', metadata: {},
  });
  const row = await store.insertRun({
    agentSlug: 'project_manager', agentId: 'agent_test_pm', agentVersion: 1, environmentId: 'env_test',
    portalId: null, portalKind: 'sandbox', clientLabel: 'PYB', projectRef: null, task: 't', startedBy: null,
    trigger: 'console', budgetCents: 1000,
  });
  await store.attachSession(row.id, created.id, 'running');
  const run = (await store.getRun(row.id)) as TeamRun;
  return { store, client, audits, gate, deps, run, sessionId: created.id, sleeps };
}

const msg = (id: string): RawSessionEvent => ({ id, type: 'agent.message', content: [{ type: 'text', text: id }] });

describe('backoffMs', () => {
  it('doubles from 2s and caps at 60s, plus jitter', () => {
    expect(backoffMs(0, 0)).toBe(2_000);
    expect(backoffMs(1, 0)).toBe(4_000);
    expect(backoffMs(4, 0)).toBe(32_000);
    expect(backoffMs(5, 0)).toBe(60_000);
    expect(backoffMs(50, 0)).toBe(60_000);
    expect(backoffMs(0, 500)).toBe(2_500);
  });
});

describe('runStream', () => {
  it('opens the stream before listing, replays history and then applies live events', async () => {
    const { deps, client, run, sessionId, store } = await setup();
    client.emit(sessionId, msg('h1'), { historyOnly: true });
    const ctl = new AbortController();
    const order: string[] = [];
    const open = client.openEventStream.bind(client);
    const list = client.listEvents.bind(client);
    client.openEventStream = async (...a) => { order.push('open'); return open(...a); };
    client.listEvents = (...a) => { order.push('list'); return list(...a); };

    const done = runStream(deps, run, ctl.signal);
    await until(() => store.seen.has('h1'), 'history');
    client.emit(sessionId, msg('l1'));
    await until(() => store.seen.has('l1'), 'live event');
    expect(order.slice(0, 2)).toEqual(['open', 'list']);

    ctl.abort();
    await done;
    expect(client.openStreamCount(sessionId)).toBe(0);
  });

  it('reconnects after a drop and picks up the gap through the list, exactly once', async () => {
    const { deps, client, run, sessionId, store, audits } = await setup();
    const ctl = new AbortController();
    const done = runStream(deps, run, ctl.signal);
    await until(() => client.openStreamCount(sessionId) === 1, 'first connect');

    client.emit(sessionId, msg('a'));
    await until(() => store.seen.has('a'), 'a');
    client.emit(sessionId, msg('gap'), { historyOnly: true });
    client.dropStreams(sessionId);
    await until(() => store.seen.has('gap'), 'gap event via list');
    await until(() => client.openStreamCount(sessionId) === 1, 'reconnect');

    client.emit(sessionId, msg('b'));
    await until(() => store.seen.has('b'), 'b');
    const audited = audits.filter((e) => e.eventType === 'team_session').map((e) => (e.payload as { eventId: string }).eventId);
    expect(audited).toEqual(['a', 'gap', 'b']);

    ctl.abort();
    await done;
    expect(client.openStreamCount(sessionId)).toBe(0);
  });

  it('backs off between reconnects and resets the attempt after a good connect', async () => {
    const { deps, client, run, sessionId, sleeps } = await setup();
    const ctl = new AbortController();
    const done = runStream(deps, run, ctl.signal);
    await until(() => client.openStreamCount(sessionId) === 1, 'connect');
    client.dropStreams(sessionId);
    await until(() => sleeps.length === 1, 'first backoff');
    await until(() => client.openStreamCount(sessionId) === 1, 'reconnect');
    client.dropStreams(sessionId);
    await until(() => sleeps.length === 2, 'second backoff');
    // Both connects succeeded, so both waits start from the base delay.
    expect(sleeps.every((ms) => ms >= 2_000 && ms < 3_000)).toBe(true);
    ctl.abort();
    await done;
  });

  it('retries with growing backoff while the connection cannot be opened', async () => {
    const { deps, client, run, sessionId, sleeps } = await setup();
    const real = client.openEventStream.bind(client);
    let failures = 2;
    client.openEventStream = async (...a) => {
      if (failures-- > 0) throw new Error('503');
      return real(...a);
    };
    const ctl = new AbortController();
    const done = runStream(deps, run, ctl.signal);
    await until(() => client.openStreamCount(sessionId) === 1, 'connect after failures');
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(2_000);
    expect(sleeps[1]!).toBeGreaterThanOrEqual(4_000);
    ctl.abort();
    await done;
  });

  it('tears down and reconnects when processEvent throws, retrying the event via list', async () => {
    const { deps, client, run, sessionId, store } = await setup();
    client.emit(sessionId, msg('h1'), { historyOnly: true });
    vi.spyOn(store, 'markEventSeen').mockRejectedValueOnce(new Error('db down'));
    const ctl = new AbortController();
    const done = runStream(deps, run, ctl.signal);
    await until(() => store.seen.has('h1'), 'h1 retried');
    await until(() => client.openStreamCount(sessionId) === 1, 'reconnected');
    expect(client.openStreamCount(sessionId)).toBe(1);
    ctl.abort();
    await done;
    expect(client.openStreamCount(sessionId)).toBe(0);
  });

  it('stops on a terminal event, including one replayed from history', async () => {
    const { deps, client, run, sessionId, store } = await setup();
    client.emit(sessionId, { id: 't1', type: 'session.status_terminated' }, { historyOnly: true });
    const ctl = new AbortController();
    await runStream(deps, run, ctl.signal); // returns by itself
    expect(store.seen.has('t1')).toBe(true);
    expect(client.openStreamCount(sessionId)).toBe(0);

    // Duplicate delivery of the terminal event still ends the loop.
    await runStream(deps, run, new AbortController().signal);
    expect(client.openStreamCount(sessionId)).toBe(0);
  });

  it('returns immediately for a run without a session', async () => {
    const { deps, run } = await setup();
    await runStream(deps, { ...run, sessionId: null }, new AbortController().signal);
  });

  it('does not wait out a backoff once aborted', async () => {
    const { deps, client, run, sessionId } = await setup();
    deps.sleep = () => new Promise<void>(() => {}); // never resolves
    client.failNext('openEventStream', new Error('boom'));
    const ctl = new AbortController();
    const done = runStream(deps, run, ctl.signal);
    await tick();
    await tick();
    ctl.abort();
    await done;
    expect(client.openStreamCount(sessionId)).toBe(0);
  });
});
