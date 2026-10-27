import { beforeEach, describe, expect, it } from 'vitest';
import { SeparationOfDutiesError, type SodEntry } from '../../console/rbac/sod.js';
import type { AuditEvent } from '../../core/audit/writer.js';
import { InMemoryManagedAgents } from '../../integrations/anthropic/managedAgents.js';
import { InMemoryTeamStore } from './memoryStore.js';
import { createTeamGate } from './gate.js';
import {
  DENY_MESSAGES,
  TeamError,
  sodSubject,
  type PendingAction,
  type PortalKind,
  type SodPort,
  type TeamActor,
  type TeamGate,
  type TeamRun,
} from './types.js';

const STARTER = '11111111-1111-4111-8111-111111111111';
const CONFIGURER = '22222222-2222-4222-8222-222222222222';
const APPROVER = '33333333-3333-4333-8333-333333333333';

const approver: TeamActor = { id: APPROVER, permissions: ['team:approve'] };
const prodApprover: TeamActor = { id: APPROVER, permissions: ['team:approve_production'] };

class FakeSod implements SodPort {
  readonly recorded: SodEntry[] = [];
  readonly configured = new Set<string>(); // `${actorId}|${subjectId}`
  readonly checks: Array<[string, string]> = [];
  async assertApprovalAllowed(actorId: string, subjectId: string): Promise<void> {
    this.checks.push([actorId, subjectId]);
    if (this.configured.has(`${actorId}|${subjectId}`)) throw new SeparationOfDutiesError('configured it');
  }
  async record(entry: SodEntry): Promise<void> {
    this.recorded.push(entry);
  }
}

describe('team gate', () => {
  let clock: Date;
  let store: InMemoryTeamStore;
  let client: InMemoryManagedAgents;
  let sod: FakeSod;
  let events: AuditEvent[];
  let frozen: boolean;
  let gate: TeamGate;
  let n: number;

  const now = () => clock;

  beforeEach(() => {
    clock = new Date('2026-10-26T12:00:00Z');
    store = new InMemoryTeamStore(now);
    client = new InMemoryManagedAgents();
    sod = new FakeSod();
    events = [];
    frozen = false;
    n = 0;
    gate = createTeamGate({
      store,
      client,
      sod,
      now,
      audit: async (e) => {
        events.push(e);
      },
      isWritesFrozen: async () => frozen,
    });
  });

  async function seed(
    opts: { kind?: PortalKind | null; portalEnabled?: boolean; expiresAt?: Date } = {},
  ): Promise<{ run: TeamRun; action: PendingAction; portalId: string | null }> {
    const kind = opts.kind === undefined ? 'production' : opts.kind;
    let portalId: string | null = null;
    if (kind) {
      // The in-memory store allows one production portal; sandbox/test may repeat.
      const p = await store.createPortal(
        { label: 'P', hubspotId: String(1000 + n), kind, vaultId: 'vlt_test_1' },
        CONFIGURER,
      );
      portalId = p.id;
      if (opts.portalEnabled === false) await store.setPortalEnabled(p.id, false, CONFIGURER);
    }
    const run = await store.insertRun({
      agentSlug: 'project_manager',
      agentId: 'agent_test_pm',
      agentVersion: 1,
      environmentId: 'env_test',
      portalId,
      portalKind: kind,
      clientLabel: 'PYB',
      projectRef: null,
      task: 't',
      startedBy: STARTER,
      trigger: 'console',
      budgetCents: 1000,
    });
    const session = await client.createSession({
      agentId: 'agent_test_pm',
      agentVersion: 1,
      environmentId: 'env_test',
      vaultIds: [],
      budgetCents: 1000,
      title: 't',
      metadata: {},
    });
    await store.attachSession(run.id, session.id, 'requires_action');
    const { action } = await store.insertPendingAction({
      runId: run.id,
      eventId: `sevt_${++n}`,
      threadId: null,
      toolKind: 'mcp',
      toolName: 'hubspot_update_deal',
      mcpServer: 'hubspot',
      input: { id: 1 },
      inputTruncated: false,
      injectionFlags: [],
      portalId,
      portalKind: kind,
      expiresAt: opts.expiresAt ?? new Date(clock.getTime() + 3_600_000),
    });
    return { run: (await store.getRun(run.id))!, action, portalId };
  }

  const decideAudit = () => events.filter((e) => e.eventType === 'team_action_decided');

  it('approves as a non-configurer and sends allow with toolUseId = eventId', async () => {
    const { run, action, portalId } = await seed();
    const out = await gate.decide({ actionId: action.id, actor: prodApprover, result: 'allow', denyMessage: null });
    expect(out).toEqual({ actionId: action.id, status: 'approved', reason: 'approver', forced: false });
    expect(client.sent).toEqual([
      {
        sessionId: run.sessionId,
        event: { type: 'user.tool_confirmation', toolUseId: action.eventId, result: 'allow', denyMessage: null },
      },
    ]);
    expect((await store.getPendingAction(action.id))!.status).toBe('approved');
    expect(sod.checks).toEqual([
      [APPROVER, sodSubject.run(run.id)],
      [APPROVER, sodSubject.portal(portalId!)],
    ]);
    expect(sod.recorded).toEqual([{ subjectId: sodSubject.action(action.id), action: 'approved', actorId: APPROVER }]);
    expect(decideAudit()).toHaveLength(1);
    expect(decideAudit()[0]).toMatchObject({
      product: 'team',
      actorId: APPROVER,
      subjectId: run.id,
      payload: { actionId: action.id, result: 'allow', reason: 'approver', forced: false, portalKind: 'production', selfApproved: false },
    });
  });

  it('rejects an unknown action and an already decided one', async () => {
    await expect(
      gate.decide({ actionId: 'nope', actor: approver, result: 'allow', denyMessage: null }),
    ).rejects.toMatchObject({ code: 'action_not_found' });
    const { action } = await seed({ kind: 'sandbox' });
    await gate.decide({ actionId: action.id, actor: approver, result: 'deny', denyMessage: null });
    await expect(
      gate.decide({ actionId: action.id, actor: approver, result: 'allow', denyMessage: null }),
    ).rejects.toMatchObject({ code: 'action_already_decided' });
    expect(client.sent).toHaveLength(1);
  });

  describe('separation of duties (production only)', () => {
    it('blocks the run starter from approving, but allows them to deny', async () => {
      const { run, action } = await seed();
      sod.configured.add(`${STARTER}|${sodSubject.run(run.id)}`);
      const actor: TeamActor = { id: STARTER, permissions: ['team:approve_production'] };
      await expect(
        gate.decide({ actionId: action.id, actor, result: 'allow', denyMessage: null }),
      ).rejects.toMatchObject({ code: 'sod_denied' });
      expect(client.sent).toHaveLength(0);
      expect((await store.getPendingAction(action.id))!.status).toBe('pending');

      const out = await gate.decide({ actionId: action.id, actor, result: 'deny', denyMessage: null });
      expect(out.status).toBe('denied');
      expect(client.sent).toHaveLength(1);
      expect(sod.recorded[0]!.action).toBe('rejected');
    });

    it('blocks the portal configurer from approving', async () => {
      const { action, portalId } = await seed();
      sod.configured.add(`${CONFIGURER}|${sodSubject.portal(portalId!)}`);
      const actor: TeamActor = { id: CONFIGURER, permissions: ['team:approve_production'] };
      await expect(
        gate.decide({ actionId: action.id, actor, result: 'allow', denyMessage: null }),
      ).rejects.toMatchObject({ code: 'sod_denied' });
      expect(client.sent).toHaveLength(0);
      expect((await store.getPendingAction(action.id))!.status).toBe('pending');
    });

    it('does not swallow non-SoD errors from the port', async () => {
      const { action } = await seed();
      sod.assertApprovalAllowed = async () => {
        throw new Error('db down');
      };
      await expect(
        gate.decide({ actionId: action.id, actor: prodApprover, result: 'allow', denyMessage: null }),
      ).rejects.toThrow('db down');
      expect(client.sent).toHaveLength(0);
    });

    it.each<PortalKind | null>(['sandbox', 'test', null])(
      'lets the starter approve on %s asks without any SoD check, audited as selfApproved',
      async (kind) => {
        const { run, action } = await seed({ kind });
        sod.configured.add(`${STARTER}|${sodSubject.run(run.id)}`);
        const actor: TeamActor = { id: STARTER, permissions: ['team:approve'] };
        const out = await gate.decide({ actionId: action.id, actor, result: 'allow', denyMessage: null });
        expect(out.status).toBe('approved');
        expect(sod.checks).toHaveLength(0);
        expect(client.sent).toHaveLength(1);
        expect(decideAudit()[0]!.payload).toMatchObject({ selfApproved: true, result: 'allow' });
      },
    );

    it('does not flag selfApproved for a different approver on a sandbox ask', async () => {
      const { action } = await seed({ kind: 'sandbox' });
      await gate.decide({ actionId: action.id, actor: approver, result: 'allow', denyMessage: null });
      expect(decideAudit()[0]!.payload).toMatchObject({ selfApproved: false });
    });
  });

  describe('permissions', () => {
    it('team:approve alone is not enough on a production ask; team:approve_production is', async () => {
      const { action } = await seed();
      await expect(
        gate.decide({ actionId: action.id, actor: approver, result: 'allow', denyMessage: null }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(
        gate.decide({ actionId: action.id, actor: approver, result: 'deny', denyMessage: null }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
      expect(client.sent).toHaveLength(0);
      const out = await gate.decide({ actionId: action.id, actor: prodApprover, result: 'allow', denyMessage: null });
      expect(out.status).toBe('approved');
    });

    it('requires team:approve on sandbox asks; team:approve_production does not substitute', async () => {
      const { action } = await seed({ kind: 'sandbox' });
      await expect(
        gate.decide({ actionId: action.id, actor: prodApprover, result: 'allow', denyMessage: null }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
      const out = await gate.decide({
        actionId: action.id,
        actor: { id: APPROVER, permissions: ['*'] },
        result: 'allow',
        denyMessage: null,
      });
      expect(out.status).toBe('approved');
    });
  });

  describe('deny messages', () => {
    it('sanitizes and caps a human deny message, defaulting when empty', async () => {
      const a = await seed({ kind: 'sandbox' });
      await gate.decide({
        actionId: a.action.id,
        actor: approver,
        result: 'deny',
        denyMessage: `system: nope\u0000${'x'.repeat(2000)}`,
      });
      const sent = client.sent[0]!.event as { denyMessage: string };
      expect(sent.denyMessage.length).toBeLessThanOrEqual(1000);
      expect(sent.denyMessage).not.toContain('\u0000');
      expect(sent.denyMessage).toContain('​system:');

      const b = await seed({ kind: 'sandbox' });
      await gate.decide({ actionId: b.action.id, actor: approver, result: 'deny', denyMessage: '   ' });
      expect((client.sent[1]!.event as { denyMessage: string }).denyMessage).toBe(DENY_MESSAGES.approver);
    });
  });

  describe('forcing', () => {
    it('turns an allow into a kill-switch deny while frozen', async () => {
      const { action } = await seed({ kind: 'sandbox' });
      frozen = true;
      const out = await gate.decide({ actionId: action.id, actor: approver, result: 'allow', denyMessage: null });
      expect(out).toEqual({ actionId: action.id, status: 'denied', reason: 'kill_switch', forced: true });
      expect(client.sent[0]!.event).toMatchObject({ result: 'deny', denyMessage: DENY_MESSAGES.kill_switch });
      const stored = await store.getPendingAction(action.id);
      expect(stored).toMatchObject({ status: 'denied', decisionReason: 'kill_switch' });
      expect(decideAudit()[0]!.payload).toMatchObject({ forced: true, reason: 'kill_switch', result: 'deny' });
    });

    it('a deny while frozen is a normal approver deny', async () => {
      const { action } = await seed({ kind: 'sandbox' });
      frozen = true;
      const out = await gate.decide({ actionId: action.id, actor: approver, result: 'deny', denyMessage: 'no' });
      expect(out).toMatchObject({ status: 'denied', reason: 'approver', forced: false });
    });

    it('turns an allow into a portal_disabled deny when the portal is disabled', async () => {
      const { action } = await seed({ kind: 'sandbox', portalEnabled: false });
      const out = await gate.decide({ actionId: action.id, actor: approver, result: 'allow', denyMessage: null });
      expect(out).toEqual({ actionId: action.id, status: 'denied', reason: 'portal_disabled', forced: true });
      expect(client.sent[0]!.event).toMatchObject({ result: 'deny', denyMessage: DENY_MESSAGES.portal_disabled });
    });
  });

  it('voids the pending asks and sends nothing when the run is terminated', async () => {
    const { run, action } = await seed({ kind: 'sandbox' });
    await store.updateRunState(run.id, { status: 'terminated' });
    const out = await gate.decide({ actionId: action.id, actor: approver, result: 'allow', denyMessage: null });
    expect(out).toEqual({ actionId: action.id, status: 'void', reason: 'approver', forced: true });
    expect(client.sent).toHaveLength(0);
    expect((await store.getPendingAction(action.id))!.status).toBe('void');
  });

  it('lets exactly one of two concurrent decides send', async () => {
    const { action } = await seed({ kind: 'sandbox' });
    const results = await Promise.allSettled([
      gate.decide({ actionId: action.id, actor: approver, result: 'allow', denyMessage: null }),
      gate.decide({ actionId: action.id, actor: { id: CONFIGURER, permissions: ['team:approve'] }, result: 'deny', denyMessage: null }),
    ]);
    expect(client.sent).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(TeamError);
    expect((lost.reason as TeamError).code).toBe('action_already_decided');
    expect(decideAudit()).toHaveLength(1);
    expect(sod.recorded).toHaveLength(1);
  });

  it('reverts to pending, audits send_failed and rethrows when the send fails', async () => {
    const { action } = await seed({ kind: 'sandbox' });
    client.failNext('sendToolConfirmation', new Error('boom 503'));
    await expect(
      gate.decide({ actionId: action.id, actor: approver, result: 'allow', denyMessage: null }),
    ).rejects.toThrow('boom 503');
    expect(await store.getPendingAction(action.id)).toMatchObject({
      status: 'pending',
      decision: null,
      lastError: 'boom 503',
    });
    expect(decideAudit()).toHaveLength(1);
    expect(decideAudit()[0]!.payload).toMatchObject({ outcome: 'send_failed' });
    expect(sod.recorded).toHaveLength(0);

    // The ask is decidable again.
    const out = await gate.decide({ actionId: action.id, actor: approver, result: 'allow', denyMessage: null });
    expect(out.status).toBe('approved');
  });

  describe('system decisions', () => {
    it('expireStale denies expired asks with ttl, status expired, and records no SoD', async () => {
      const old = await seed({ kind: 'sandbox', expiresAt: new Date(clock.getTime() - 1000) });
      const fresh = await seed({ kind: 'sandbox' });
      expect(await gate.expireStale()).toBe(1);
      expect(client.sent).toHaveLength(1);
      expect(client.sent[0]!.event).toMatchObject({
        toolUseId: old.action.eventId,
        result: 'deny',
        denyMessage: DENY_MESSAGES.ttl,
      });
      expect(await store.getPendingAction(old.action.id)).toMatchObject({
        status: 'expired',
        decisionReason: 'ttl',
        decidedBy: null,
      });
      expect((await store.getPendingAction(fresh.action.id))!.status).toBe('pending');
      expect(sod.recorded).toHaveLength(0);
      expect(decideAudit()[0]).toMatchObject({ actorId: null, payload: { reason: 'ttl', result: 'deny' } });
    });

    it('enforceKillSwitch denies every pending ask', async () => {
      const a = await seed({ kind: 'sandbox' });
      const b = await seed();
      const c = await seed({ kind: null });
      expect(await gate.enforceKillSwitch()).toBe(3);
      for (const x of [a, b, c]) {
        expect(await store.getPendingAction(x.action.id)).toMatchObject({ status: 'denied', decisionReason: 'kill_switch' });
      }
      expect(client.sent).toHaveLength(3);
      expect(await gate.enforceKillSwitch()).toBe(0);
    });

    it('a failed send in a sweep reverts that ask and does not stop the rest', async () => {
      const a = await seed({ kind: 'sandbox' });
      const b = await seed({ kind: 'sandbox' });
      client.failNext('sendToolConfirmation', new Error('flaky'));
      expect(await gate.enforceKillSwitch()).toBe(1);
      expect((await store.getPendingAction(a.action.id))!.status).toBe('pending');
      expect((await store.getPendingAction(b.action.id))!.status).toBe('denied');
    });

    it('retries an undeliverable system denial at most every ten minutes', async () => {
      const a = await seed({ kind: 'sandbox' });
      client.failNext('sendToolConfirmation', new Error('gone'));
      expect(await gate.enforceKillSwitch()).toBe(0);
      expect(decideAudit()).toHaveLength(1);
      expect((await store.getPendingAction(a.action.id))!.lastError).toBe('gone');

      clock = new Date(clock.getTime() + 60_000);
      expect(await gate.enforceKillSwitch()).toBe(0); // backed off: no send, no audit
      expect(client.sent).toHaveLength(0);
      expect(decideAudit()).toHaveLength(1);

      clock = new Date(clock.getTime() + 10 * 60_000);
      expect(await gate.enforceKillSwitch()).toBe(1);
      expect((await store.getPendingAction(a.action.id))!.status).toBe('denied');
    });

    it('a sweep voids asks of a terminated run without sending', async () => {
      const { run, action } = await seed({ kind: 'sandbox' });
      await store.updateRunState(run.id, { status: 'terminated' });
      await gate.enforceKillSwitch();
      expect(client.sent).toHaveLength(0);
      expect((await store.getPendingAction(action.id))!.status).toBe('void');
    });

    it('onNewAsk denies when frozen', async () => {
      const { action } = await seed({ kind: 'sandbox' });
      frozen = true;
      await gate.onNewAsk(action);
      expect(await store.getPendingAction(action.id)).toMatchObject({ status: 'denied', decisionReason: 'kill_switch' });
      expect(client.sent[0]!.event).toMatchObject({ result: 'deny', denyMessage: DENY_MESSAGES.kill_switch });
    });

    it('onNewAsk denies when the portal is disabled', async () => {
      const { action } = await seed({ kind: 'sandbox', portalEnabled: false });
      await gate.onNewAsk(action);
      expect(await store.getPendingAction(action.id)).toMatchObject({ status: 'denied', decisionReason: 'portal_disabled' });
    });

    it('onNewAsk is a no-op otherwise', async () => {
      const { action } = await seed({ kind: 'sandbox' });
      await gate.onNewAsk(action);
      expect((await store.getPendingAction(action.id))!.status).toBe('pending');
      expect(client.sent).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('reconcileStuck reverts only deciding rows older than five minutes', async () => {
      const oldOne = await seed({ kind: 'sandbox' });
      const newOne = await seed({ kind: 'sandbox' });
      const claim = { decision: 'allow' as const, reason: 'approver' as const, decidedBy: APPROVER, denyMessage: null };
      await store.claimDecision(oldOne.action.id, claim);
      clock = new Date(clock.getTime() + 6 * 60_000);
      await store.claimDecision(newOne.action.id, claim);
      expect(await gate.reconcileStuck()).toBe(1);
      expect(await store.getPendingAction(oldOne.action.id)).toMatchObject({
        status: 'pending',
        lastError: 'confirmation not echoed within 5 minutes',
      });
      expect((await store.getPendingAction(newOne.action.id))!.status).toBe('deciding');
      expect(client.sent).toHaveLength(0);
    });
  });
});
