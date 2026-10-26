import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { INTEGRATION_URL, makeTestPool, resetAndMigrate } from '../../test/itestDb.js';
import { PgTeamStore } from './store.js';
import type { NewPendingAction, NewRun, PortalInput, TeamRun } from './types.js';

// Skipped unless a real Postgres is provided (INTEGRATION_DATABASE_URL).
const d = INTEGRATION_URL ? describe : describe.skip;

const T0 = new Date('2026-06-24T12:00:00.000Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);

let hubspotSeq = 1000;
const portalInput = (over: Partial<PortalInput> = {}): PortalInput => ({
  label: 'PYB sandbox',
  hubspotId: String(hubspotSeq++),
  kind: 'sandbox',
  vaultId: 'vlt_abc123',
  ...over,
});

const newRun = (over: Partial<NewRun> = {}): NewRun => ({
  agentSlug: 'project_manager',
  agentId: 'agent_01',
  agentVersion: 3,
  environmentId: 'env_01',
  portalId: null,
  portalKind: null,
  clientLabel: 'PYB',
  projectRef: null,
  task: 'Plan the onboarding project',
  startedBy: null,
  trigger: 'console',
  budgetCents: 500,
  ...over,
});

let eventSeq = 0;
const newAction = (runId: string, over: Partial<NewPendingAction> = {}): NewPendingAction => ({
  runId,
  eventId: `sevt_${eventSeq++}`,
  threadId: null,
  toolKind: 'mcp',
  toolName: 'hubspot_create_task',
  mcpServer: 'hubspot',
  input: { title: 'Call back', nested: { n: [1, 2] } },
  inputTruncated: false,
  injectionFlags: [],
  portalId: null,
  portalKind: null,
  expiresAt: at(60),
  ...over,
});

d('PgTeamStore (Postgres)', () => {
  let pool: Pool;
  let clock: Date;
  let store: PgTeamStore;
  let userId: string;

  beforeAll(async () => {
    pool = makeTestPool();
    await resetAndMigrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE team_pending_actions, team_run_events, team_runs, team_portals, users RESTART IDENTITY CASCADE',
    );
    userId = (await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ('t@x.com','h') RETURNING id`))
      .rows[0]!.id;
    clock = T0;
    store = new PgTeamStore(pool, () => clock);
  });

  const liveRun = async (over: Partial<NewRun> = {}): Promise<TeamRun> => {
    const run = await store.insertRun(newRun(over));
    await store.attachSession(run.id, `sesn_${run.id}`, 'running');
    return (await store.getRun(run.id))!;
  };

  it('migration applies on a clean DB and the grants block is a no-op without app_rw', async () => {
    const { rows } = await pool.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables
       WHERE table_name IN ('team_portals','team_runs','team_run_events','team_pending_actions') ORDER BY 1`,
    );
    expect(rows.map((r) => r.t)).toEqual(['team_pending_actions', 'team_portals', 'team_run_events', 'team_runs']);
    const role = await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'app_rw'`);
    expect(role.rowCount).toBe(0);
  });

  describe('team_portals', () => {
    it('creates, reads, lists and toggles a portal', async () => {
      const p = await store.createPortal(portalInput({ label: 'PYB production', kind: 'production' }), userId);
      expect(p).toMatchObject({ label: 'PYB production', kind: 'production', enabled: true, vaultId: 'vlt_abc123' });
      expect(p.createdAt).toEqual(T0);
      expect(await store.getPortal(p.id)).toEqual(p);
      expect(await store.getPortal('00000000-0000-0000-0000-000000000000')).toBeNull();

      clock = at(5);
      const off = await store.setPortalEnabled(p.id, false, userId);
      expect(off).toMatchObject({ enabled: false, updatedAt: at(5), createdAt: T0 });
      expect(await store.setPortalEnabled('00000000-0000-0000-0000-000000000000', true, userId)).toBeNull();

      clock = at(1);
      await store.createPortal(portalInput(), userId);
      expect((await store.listPortals()).map((x) => x.kind)).toEqual(['production', 'sandbox']);
    });

    it('rejects a non-numeric hubspot id, a bad vault id and an unknown kind', async () => {
      await expect(store.createPortal(portalInput({ hubspotId: '12ab' }), userId)).rejects.toThrow(/hubspot_id_chk/);
      await expect(store.createPortal(portalInput({ vaultId: 'not-a-vault' }), userId)).rejects.toThrow(/vault_id_chk/);
      await expect(store.createPortal(portalInput({ kind: 'staging' as never }), userId)).rejects.toThrow(/kind_chk/);
    });

    it('rejects a duplicate hubspot id', async () => {
      await store.createPortal(portalInput({ hubspotId: '777' }), userId);
      await expect(store.createPortal(portalInput({ hubspotId: '777' }), userId)).rejects.toThrow(/hubspot_id_key/);
    });

    it('allows one production portal only, but many sandboxes', async () => {
      await store.createPortal(portalInput({ kind: 'production' }), userId);
      await expect(store.createPortal(portalInput({ kind: 'production' }), userId)).rejects.toThrow(
        /one_production_idx/,
      );
      await store.createPortal(portalInput({ kind: 'sandbox' }), userId);
      await store.createPortal(portalInput({ kind: 'sandbox' }), userId);
      expect(await store.listPortals()).toHaveLength(3);
    });
  });

  describe('team_runs', () => {
    it('inserts a starting run with no session and maps every column', async () => {
      const portal = await store.createPortal(portalInput(), userId);
      const run = await store.insertRun(
        newRun({ portalId: portal.id, portalKind: 'sandbox', projectRef: '123', startedBy: userId }),
      );
      expect(run).toMatchObject({
        sessionId: null,
        status: 'starting',
        stopReason: null,
        listCostCents: null,
        lastError: null,
        lastEventAt: null,
        agentSlug: 'project_manager',
        agentVersion: 3,
        portalId: portal.id,
        portalKind: 'sandbox',
        projectRef: '123',
        startedBy: userId,
        budgetCents: 500,
        createdAt: T0,
        updatedAt: T0,
      });
      expect(await store.getRun(run.id)).toEqual(run);
      expect(await store.getRun('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('session_chk: a running run needs a session id', async () => {
      const run = await store.insertRun(newRun());
      await expect(store.updateRunState(run.id, { status: 'running' })).rejects.toThrow(/session_chk/);
      await store.attachSession(run.id, 'sesn_1', 'idle');
      expect(await store.getRun(run.id)).toMatchObject({ sessionId: 'sesn_1', status: 'idle' });
    });

    it('rejects a duplicate session id', async () => {
      const a = await store.insertRun(newRun());
      const b = await store.insertRun(newRun());
      await store.attachSession(a.id, 'sesn_dup', 'idle');
      await expect(store.attachSession(b.id, 'sesn_dup', 'idle')).rejects.toThrow(/session_id_key/);
    });

    it('portal_pair_chk: portal id and kind are set together', async () => {
      const portal = await store.createPortal(portalInput(), userId);
      await expect(store.insertRun(newRun({ portalId: portal.id, portalKind: null }))).rejects.toThrow(
        /portal_pair_chk/,
      );
      await expect(store.insertRun(newRun({ portalId: null, portalKind: 'sandbox' }))).rejects.toThrow(
        /portal_pair_chk/,
      );
    });

    it('rejects a bad project_ref', async () => {
      await expect(store.insertRun(newRun({ projectRef: 'abc; DROP' }))).rejects.toThrow(/project_ref_chk/);
    });

    it('markRunFailed caps last_error at 2000 chars; unknown run throws', async () => {
      const run = await store.insertRun(newRun());
      clock = at(2);
      await store.markRunFailed(run.id, 'x'.repeat(5000));
      const got = (await store.getRun(run.id))!;
      expect(got.status).toBe('failed');
      expect(got.lastError).toHaveLength(2000);
      expect(got.updatedAt).toEqual(at(2));
      await expect(store.markRunFailed('00000000-0000-0000-0000-000000000000', 'x')).rejects.toThrow(/unknown run/);
    });

    it('updateRunState applies only the keys present and always bumps updated_at', async () => {
      const run = await liveRun();
      clock = at(3);
      await store.updateRunState(run.id, {
        status: 'idle',
        stopReason: 'end_turn',
        listCostCents: 42,
        budgetCents: 900,
        lastError: 'boom',
        lastEventAt: at(2),
      });
      expect(await store.getRun(run.id)).toMatchObject({
        status: 'idle',
        stopReason: 'end_turn',
        listCostCents: 42,
        budgetCents: 900,
        lastError: 'boom',
        lastEventAt: at(2),
        updatedAt: at(3),
      });
      clock = at(4);
      await store.updateRunState(run.id, { lastError: null, listCostCents: null });
      expect(await store.getRun(run.id)).toMatchObject({
        status: 'idle', // untouched
        stopReason: 'end_turn', // untouched
        lastError: null,
        listCostCents: null,
        budgetCents: 900,
        updatedAt: at(4),
      });
      clock = at(5);
      await store.updateRunState(run.id, {}); // empty patch still touches updated_at
      expect((await store.getRun(run.id))!.updatedAt).toEqual(at(5));
    });

    it('listRuns is newest first and honours the limit', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        clock = at(i);
        ids.push((await store.insertRun(newRun({ task: `t${i}` }))).id);
      }
      expect((await store.listRuns(10)).map((r) => r.id)).toEqual([ids[2], ids[1], ids[0]]);
      expect(await store.listRuns(2)).toHaveLength(2);
    });

    it('listStreamableRuns: live and recent-idle runs in; old idle, terminal and sessionless out', async () => {
      const running = await liveRun();
      const asking = await liveRun();
      await store.updateRunState(asking.id, { status: 'requires_action' });
      const budget = await liveRun();
      await store.updateRunState(budget.id, { status: 'budget_reached' });
      const resched = await liveRun();
      await store.updateRunState(resched.id, { status: 'rescheduling' });

      clock = at(-30);
      const oldIdle = await liveRun();
      await store.updateRunState(oldIdle.id, { status: 'idle' });
      clock = at(-1);
      const freshIdle = await liveRun();
      await store.updateRunState(freshIdle.id, { status: 'idle' });

      clock = T0;
      const done = await liveRun();
      await store.updateRunState(done.id, { status: 'terminated' });
      const failed = await liveRun();
      await store.updateRunState(failed.id, { status: 'failed' });
      const starting = await store.insertRun(newRun()); // no session yet

      const got = (await store.listStreamableRuns(at(-10))).map((r) => r.id).sort();
      expect(got).toEqual([running.id, asking.id, budget.id, resched.id, freshIdle.id].sort());
      expect(got).not.toContain(oldIdle.id);
      expect(got).not.toContain(done.id);
      expect(got).not.toContain(failed.id);
      expect(got).not.toContain(starting.id);
    });
  });

  describe('team_run_events', () => {
    it('markEventSeen is idempotent (first insert wins) and hasSeenEvent flips', async () => {
      const run = await liveRun();
      expect(await store.hasSeenEvent('evt_1')).toBe(false);
      await store.markEventSeen({ eventKey: 'evt_1', runId: run.id, eventType: 'agent.message', threadId: null, processedAt: at(1) });
      expect(await store.hasSeenEvent('evt_1')).toBe(true);
      await store.markEventSeen({ eventKey: 'evt_1', runId: run.id, eventType: 'other', threadId: 'thr_1', processedAt: null });
      const { rows } = await pool.query(`SELECT event_type, thread_id, processed_at FROM team_run_events WHERE event_key = 'evt_1'`);
      expect(rows).toEqual([{ event_type: 'agent.message', thread_id: null, processed_at: at(1) }]);
      expect(await store.hasSeenEvent('evt_2')).toBe(false);
    });
  });

  describe('team_pending_actions', () => {
    it('insert maps columns and round-trips jsonb input; duplicate event_id returns the same row', async () => {
      const run = await liveRun();
      const input = newAction(run.id, { injectionFlags: ['role_marker'], inputTruncated: true, threadId: 'thr_9' });
      const first = await store.insertPendingAction(input);
      expect(first.inserted).toBe(true);
      expect(first.action).toMatchObject({
        status: 'pending',
        decision: null,
        decisionReason: null,
        input: { title: 'Call back', nested: { n: [1, 2] } },
        injectionFlags: ['role_marker'],
        inputTruncated: true,
        threadId: 'thr_9',
        expiresAt: at(60),
        createdAt: T0,
      });

      const dup = await store.insertPendingAction({ ...input, toolName: 'something_else' });
      expect(dup.inserted).toBe(false);
      expect(dup.action).toEqual(first.action);
      expect(await store.getPendingAction(first.action.id)).toEqual(first.action);
      expect(await store.getPendingAction('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('stores non-object inputs as jsonb too', async () => {
      const run = await liveRun();
      const s = await store.insertPendingAction(newAction(run.id, { input: 'just a string' }));
      const n = await store.insertPendingAction(newAction(run.id, { input: null }));
      expect(s.action.input).toBe('just a string');
      expect(n.action.input).toBeNull();
    });

    it('lists by status oldest first, and per run', async () => {
      const r1 = await liveRun();
      const r2 = await liveRun();
      clock = at(1);
      const a = (await store.insertPendingAction(newAction(r1.id))).action;
      clock = at(2);
      const b = (await store.insertPendingAction(newAction(r2.id))).action;
      clock = at(3);
      const c = (await store.insertPendingAction(newAction(r1.id))).action;
      await store.claimDecision(b.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: null });

      expect((await store.listPendingActions(['pending'], 10)).map((x) => x.id)).toEqual([a.id, c.id]);
      expect((await store.listPendingActions(['pending', 'deciding'], 10)).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
      expect(await store.listPendingActions(['pending', 'deciding'], 2)).toHaveLength(2);
      expect(await store.listPendingActions([], 10)).toEqual([]);
      expect((await store.listPendingForRun(r1.id)).map((x) => x.id)).toEqual([a.id, c.id]);
    });

    it('claimDecision moves pending to deciding and records the claim', async () => {
      const run = await liveRun();
      const { action } = await store.insertPendingAction(newAction(run.id));
      clock = at(2);
      const claimed = await store.claimDecision(action.id, {
        decision: 'deny',
        reason: 'approver',
        decidedBy: userId,
        denyMessage: 'nope',
      });
      expect(claimed).toMatchObject({
        status: 'deciding',
        decision: 'deny',
        decisionReason: 'approver',
        decidedBy: userId,
        denyMessage: 'nope',
        decidedAt: at(2),
        updatedAt: at(2),
      });
      // Not pending any more: a second claim gets nothing.
      expect(
        await store.claimDecision(action.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: null }),
      ).toBeNull();
      expect(
        await store.claimDecision('00000000-0000-0000-0000-000000000000', {
          decision: 'allow',
          reason: 'approver',
          decidedBy: null,
          denyMessage: null,
        }),
      ).toBeNull();
    });

    it('two concurrent claims: exactly one wins and the loser changes nothing', async () => {
      const run = await liveRun();
      for (let round = 0; round < 10; round++) {
        const { action } = await store.insertPendingAction(newAction(run.id));
        const [x, y] = await Promise.all([
          store.claimDecision(action.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: null }),
          store.claimDecision(action.id, { decision: 'deny', reason: 'kill_switch', decidedBy: null, denyMessage: 'frozen' }),
        ]);
        expect([x, y].filter((r) => r !== null)).toHaveLength(1);
        const winner = (x ?? y)!;
        const stored = (await store.getPendingAction(action.id))!;
        expect(stored.status).toBe('deciding');
        expect(stored.decision).toBe(winner.decision);
        expect(stored.decisionReason).toBe(winner.decisionReason);
      }
    });

    it('finalizeDecision yields approved / denied / expired by decision and reason', async () => {
      const run = await liveRun();
      const cases = [
        { decision: 'allow', reason: 'approver', want: 'approved' },
        { decision: 'deny', reason: 'approver', want: 'denied' },
        { decision: 'deny', reason: 'kill_switch', want: 'denied' },
        { decision: 'deny', reason: 'ttl', want: 'expired' },
      ] as const;
      for (const c of cases) {
        const { action } = await store.insertPendingAction(newAction(run.id));
        await store.claimDecision(action.id, { decision: c.decision, reason: c.reason, decidedBy: null, denyMessage: null });
        clock = new Date(clock.getTime() + 1000);
        await store.finalizeDecision(action.id);
        const got = (await store.getPendingAction(action.id))!;
        expect(got.status).toBe(c.want);
        expect(got.updatedAt).toEqual(clock);
      }
      // Finalizing a non-deciding row is a no-op.
      const { action } = await store.insertPendingAction(newAction(run.id));
      await store.finalizeDecision(action.id);
      expect((await store.getPendingAction(action.id))!.status).toBe('pending');
    });

    it('lifecycle CHECK rejects approved with decision=deny (and the other impossible combinations)', async () => {
      const run = await liveRun();
      const { action } = await store.insertPendingAction(newAction(run.id));
      await expect(
        pool.query(
          `UPDATE team_pending_actions SET status='approved', decision='deny', decision_reason='approver' WHERE id=$1`,
          [action.id],
        ),
      ).rejects.toThrow(/lifecycle_chk/);
      await expect(
        pool.query(`UPDATE team_pending_actions SET status='expired', decision='deny', decision_reason='approver' WHERE id=$1`, [
          action.id,
        ]),
      ).rejects.toThrow(/lifecycle_chk/);
      await expect(
        pool.query(`UPDATE team_pending_actions SET status='pending', decision='allow', decision_reason='approver' WHERE id=$1`, [
          action.id,
        ]),
      ).rejects.toThrow(/lifecycle_chk/);
      expect((await store.getPendingAction(action.id))!.status).toBe('pending');
    });

    it('revertDecision returns deciding to pending, clears the decision and records the error', async () => {
      const run = await liveRun();
      const { action } = await store.insertPendingAction(newAction(run.id));
      await store.claimDecision(action.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: 'm' });
      clock = at(3);
      await store.revertDecision(action.id, 'e'.repeat(3000));
      const got = (await store.getPendingAction(action.id))!;
      expect(got).toMatchObject({
        status: 'pending',
        decision: null,
        decisionReason: null,
        decidedBy: null,
        denyMessage: null,
        decidedAt: null,
        updatedAt: at(3),
      });
      expect(got.lastError).toHaveLength(2000);
      // Claimable again afterwards.
      expect(
        await store.claimDecision(action.id, { decision: 'deny', reason: 'approver', decidedBy: userId, denyMessage: null }),
      ).not.toBeNull();
      // Reverting a row that is not deciding changes nothing.
      await store.finalizeDecision(action.id);
      await store.revertDecision(action.id, 'late');
      expect((await store.getPendingAction(action.id))!.status).toBe('denied');
    });

    describe('settleFromEcho', () => {
      it('pending becomes approved/denied as an external decision (wasOurs=false)', async () => {
        const run = await liveRun();
        const a = (await store.insertPendingAction(newAction(run.id))).action;
        const b = (await store.insertPendingAction(newAction(run.id))).action;
        clock = at(4);
        const allowed = await store.settleFromEcho(a.eventId, 'allow', at(3));
        expect(allowed!.wasOurs).toBe(false);
        expect(allowed!.action).toMatchObject({
          status: 'approved',
          decision: 'allow',
          decisionReason: 'external',
          decidedBy: null,
          decidedAt: at(3),
          updatedAt: at(4),
        });
        const denied = await store.settleFromEcho(b.eventId, 'deny', at(3));
        expect(denied!.action).toMatchObject({ status: 'denied', decision: 'deny', decisionReason: 'external' });
      });

      it('deciding with a matching echo is finalised by our own decision (wasOurs=true)', async () => {
        const run = await liveRun();
        const a = (await store.insertPendingAction(newAction(run.id))).action;
        await store.claimDecision(a.id, { decision: 'deny', reason: 'ttl', decidedBy: null, denyMessage: 'late' });
        const res = await store.settleFromEcho(a.eventId, 'deny', at(1));
        expect(res!.wasOurs).toBe(true);
        expect(res!.action).toMatchObject({ status: 'expired', decision: 'deny', decisionReason: 'ttl' });
      });

      it('deciding with a differing echo settles to the echoed result as external (wasOurs=false)', async () => {
        const run = await liveRun();
        const a = (await store.insertPendingAction(newAction(run.id))).action;
        const b = (await store.insertPendingAction(newAction(run.id))).action;
        await store.claimDecision(a.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: null });
        await store.claimDecision(b.id, { decision: 'deny', reason: 'ttl', decidedBy: null, denyMessage: 'late' });
        const toDeny = await store.settleFromEcho(a.eventId, 'deny', at(1));
        expect(toDeny!.wasOurs).toBe(false);
        expect(toDeny!.action).toMatchObject({ status: 'denied', decision: 'deny', decisionReason: 'external', decidedBy: null });
        const toAllow = await store.settleFromEcho(b.eventId, 'allow', at(1));
        expect(toAllow!.wasOurs).toBe(false);
        expect(toAllow!.action).toMatchObject({ status: 'approved', decision: 'allow', decisionReason: 'external', decidedBy: null });
      });

      it('terminal rows and unknown tool-use ids give null', async () => {
        const run = await liveRun();
        const a = (await store.insertPendingAction(newAction(run.id))).action;
        await store.claimDecision(a.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: null });
        await store.finalizeDecision(a.id);
        expect(await store.settleFromEcho(a.eventId, 'allow', at(1))).toBeNull();
        expect((await store.getPendingAction(a.id))!.status).toBe('approved');
        expect(await store.settleFromEcho('sevt_unknown', 'allow', at(1))).toBeNull();
      });

      it('an echo racing a claim lands on exactly one outcome', async () => {
        const run = await liveRun();
        const a = (await store.insertPendingAction(newAction(run.id))).action;
        const [claimed, echo] = await Promise.all([
          store.claimDecision(a.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: null }),
          store.settleFromEcho(a.eventId, 'deny', at(1)),
        ]);
        const final = (await store.getPendingAction(a.id))!;
        if (claimed) {
          // Claim won the row lock: the echo (deny) then saw our 'allow' deciding row
          // and the API's answer wins as an external denial.
          expect(echo!.wasOurs).toBe(false);
          expect(final).toMatchObject({ status: 'denied', decisionReason: 'external', decidedBy: null });
        } else {
          // Echo won: external denial, and the claim found nothing pending.
          expect(echo!.wasOurs).toBe(false);
          expect(final).toMatchObject({ status: 'denied', decisionReason: 'external' });
        }
      });
    });

    it('listExpired returns only pending rows at/after expiry, oldest first, limited', async () => {
      const run = await liveRun();
      clock = at(1);
      const e1 = (await store.insertPendingAction(newAction(run.id, { expiresAt: at(10) }))).action;
      clock = at(2);
      const e2 = (await store.insertPendingAction(newAction(run.id, { expiresAt: at(5) }))).action;
      const live = (await store.insertPendingAction(newAction(run.id, { expiresAt: at(30) }))).action;
      const claimed = (await store.insertPendingAction(newAction(run.id, { expiresAt: at(1) }))).action;
      await store.claimDecision(claimed.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: null });

      expect((await store.listExpired(at(10), 10)).map((x) => x.id)).toEqual([e1.id, e2.id]); // boundary inclusive
      expect((await store.listExpired(at(9), 10)).map((x) => x.id)).toEqual([e2.id]);
      expect(await store.listExpired(at(10), 1)).toHaveLength(1);
      expect((await store.listExpired(at(10), 10)).map((x) => x.id)).not.toContain(live.id);
    });

    it('listStuckDeciding returns deciding rows last touched before the cutoff', async () => {
      const run = await liveRun();
      const old = (await store.insertPendingAction(newAction(run.id))).action;
      const fresh = (await store.insertPendingAction(newAction(run.id))).action;
      const pending = (await store.insertPendingAction(newAction(run.id))).action;
      clock = at(1);
      await store.claimDecision(old.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: null });
      clock = at(9);
      await store.claimDecision(fresh.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: null });

      const stuck = await store.listStuckDeciding(at(5), 10);
      expect(stuck.map((x) => x.id)).toEqual([old.id]);
      expect(stuck.map((x) => x.id)).not.toContain(pending.id);
      expect(await store.listStuckDeciding(at(1), 10)).toEqual([]); // strictly older than
      expect(await store.listStuckDeciding(at(20), 1)).toHaveLength(1);
    });

    it('voidPendingForRun voids pending and deciding rows of that run only and returns the count', async () => {
      const r1 = await liveRun();
      const r2 = await liveRun();
      const p = (await store.insertPendingAction(newAction(r1.id))).action;
      const dcd = (await store.insertPendingAction(newAction(r1.id))).action;
      const done = (await store.insertPendingAction(newAction(r1.id))).action;
      const other = (await store.insertPendingAction(newAction(r2.id))).action;
      await store.claimDecision(dcd.id, { decision: 'allow', reason: 'approver', decidedBy: userId, denyMessage: null });
      await store.claimDecision(done.id, { decision: 'deny', reason: 'approver', decidedBy: userId, denyMessage: null });
      await store.finalizeDecision(done.id);

      expect(await store.voidPendingForRun(r1.id)).toBe(2);
      expect((await store.getPendingAction(p.id))!.status).toBe('void');
      expect((await store.getPendingAction(dcd.id))!.status).toBe('void');
      expect((await store.getPendingAction(done.id))!.status).toBe('denied');
      expect((await store.getPendingAction(other.id))!.status).toBe('pending');
      expect(await store.voidPendingForRun(r1.id)).toBe(0);
    });
  });
});
