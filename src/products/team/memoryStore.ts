import { randomUUID } from 'node:crypto';
import type {
  DecisionClaim,
  NewPendingAction,
  NewRun,
  PendingAction,
  PendingStatus,
  PortalInput,
  RunStatePatch,
  RunStatus,
  SeenEvent,
  TeamPortal,
  TeamRun,
  TeamStore,
  ToolDecision,
} from './types.js';

/**
 * In-memory TeamStore twin for unit tests. Mirrors the SQL semantics PgTeamStore
 * implements (and store.itest.ts proves): the same unique constraints, the same
 * state machine on pending actions, the same predicates. Test-only.
 */
export class InMemoryTeamStore implements TeamStore {
  readonly portals = new Map<string, TeamPortal>();
  readonly runs = new Map<string, TeamRun>();
  readonly seen = new Map<string, SeenEvent>();
  readonly actions = new Map<string, PendingAction>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  // ---- portals ----
  async listPortals(): Promise<TeamPortal[]> {
    return [...this.portals.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async getPortal(id: string): Promise<TeamPortal | null> {
    return this.portals.get(id) ?? null;
  }
  async createPortal(input: PortalInput, _actorId: string): Promise<TeamPortal> {
    for (const p of this.portals.values()) {
      if (p.hubspotId === input.hubspotId) throw new Error('duplicate hubspot_id');
      if (input.kind === 'production' && p.kind === 'production') throw new Error('production portal exists');
    }
    const t = this.now();
    const portal: TeamPortal = { id: randomUUID(), ...input, enabled: true, createdAt: t, updatedAt: t };
    this.portals.set(portal.id, portal);
    return portal;
  }
  async setPortalEnabled(id: string, enabled: boolean, _actorId: string): Promise<TeamPortal | null> {
    const p = this.portals.get(id);
    if (!p) return null;
    const next = { ...p, enabled, updatedAt: this.now() };
    this.portals.set(id, next);
    return next;
  }

  // ---- runs ----
  async insertRun(input: NewRun): Promise<TeamRun> {
    const t = this.now();
    const run: TeamRun = {
      id: randomUUID(),
      sessionId: null,
      ...input,
      status: 'starting',
      stopReason: null,
      listCostCents: null,
      lastError: null,
      lastEventAt: null,
      createdAt: t,
      updatedAt: t,
    };
    this.runs.set(run.id, run);
    return run;
  }
  async attachSession(runId: string, sessionId: string, status: RunStatus): Promise<void> {
    for (const r of this.runs.values()) if (r.sessionId === sessionId) throw new Error('duplicate session_id');
    this.patchRun(runId, { sessionId, status });
  }
  async markRunFailed(runId: string, error: string): Promise<void> {
    this.patchRun(runId, { status: 'failed', lastError: error.slice(0, 2000) });
  }
  async getRun(id: string): Promise<TeamRun | null> {
    return this.runs.get(id) ?? null;
  }
  async listRuns(limit: number): Promise<TeamRun[]> {
    return [...this.runs.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }
  async listStreamableRuns(idleCutoff: Date): Promise<TeamRun[]> {
    const live: RunStatus[] = ['starting', 'running', 'requires_action', 'budget_reached', 'rescheduling'];
    return [...this.runs.values()].filter(
      (r) => r.sessionId !== null && (live.includes(r.status) || (r.status === 'idle' && r.updatedAt > idleCutoff)),
    );
  }
  async updateRunState(runId: string, patch: RunStatePatch): Promise<void> {
    const applied: Partial<TeamRun> = {};
    if ('status' in patch && patch.status !== undefined) applied.status = patch.status;
    if ('stopReason' in patch) applied.stopReason = patch.stopReason ?? null;
    if ('listCostCents' in patch) applied.listCostCents = patch.listCostCents ?? null;
    if ('budgetCents' in patch && patch.budgetCents !== undefined) applied.budgetCents = patch.budgetCents;
    if ('lastError' in patch) applied.lastError = patch.lastError ?? null;
    if ('lastEventAt' in patch && patch.lastEventAt !== undefined) applied.lastEventAt = patch.lastEventAt;
    this.patchRun(runId, applied);
  }

  async transitionRunStatus(
    runId: string,
    from: readonly RunStatus[],
    patch: RunStatePatch & { status: RunStatus },
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || !from.includes(run.status)) return false;
    await this.updateRunState(runId, patch);
    return true;
  }

  // ---- event ledger ----
  async hasSeenEvent(eventKey: string): Promise<boolean> {
    return this.seen.has(eventKey);
  }
  async markEventSeen(entry: SeenEvent): Promise<void> {
    if (!this.seen.has(entry.eventKey)) this.seen.set(entry.eventKey, entry); // first insert wins
  }

  // ---- pending actions ----
  async insertPendingAction(input: NewPendingAction): Promise<{ inserted: boolean; action: PendingAction }> {
    for (const a of this.actions.values()) if (a.eventId === input.eventId) return { inserted: false, action: a };
    const t = this.now();
    const action: PendingAction = {
      id: randomUUID(),
      ...input,
      status: 'pending',
      decision: null,
      decisionReason: null,
      denyMessage: null,
      decidedBy: null,
      decidedAt: null,
      lastError: null,
      createdAt: t,
      updatedAt: t,
    };
    this.actions.set(action.id, action);
    return { inserted: true, action };
  }
  async getPendingAction(id: string): Promise<PendingAction | null> {
    return this.actions.get(id) ?? null;
  }
  async listPendingActions(statuses: readonly PendingStatus[], limit: number): Promise<PendingAction[]> {
    return [...this.actions.values()]
      .filter((a) => statuses.includes(a.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }
  async listPendingForRun(runId: string): Promise<PendingAction[]> {
    return [...this.actions.values()]
      .filter((a) => a.runId === runId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async claimDecision(id: string, claim: DecisionClaim): Promise<PendingAction | null> {
    const a = this.actions.get(id);
    if (!a || a.status !== 'pending') return null;
    return this.patchAction(id, {
      status: 'deciding',
      decision: claim.decision,
      decisionReason: claim.reason,
      decidedBy: claim.decidedBy,
      denyMessage: claim.denyMessage,
      decidedAt: this.now(),
    });
  }
  async finalizeDecision(id: string): Promise<void> {
    const a = this.actions.get(id);
    if (!a || a.status !== 'deciding') return;
    this.patchAction(id, { status: finalStatus(a.decision, a.decisionReason) });
  }
  async revertDecision(id: string, error: string): Promise<void> {
    const a = this.actions.get(id);
    if (!a || a.status !== 'deciding') return;
    this.patchAction(id, {
      status: 'pending',
      decision: null,
      decisionReason: null,
      decidedBy: null,
      denyMessage: null,
      decidedAt: null,
      lastError: error.slice(0, 2000),
    });
  }
  async settleFromEcho(
    toolUseId: string,
    result: ToolDecision,
    at: Date,
  ): Promise<{ action: PendingAction; wasOurs: boolean } | null> {
    const a = [...this.actions.values()].find((x) => x.eventId === toolUseId);
    if (!a) return null;
    if (a.status === 'deciding') {
      if (a.decision !== result) {
        // The API's answer is the truth (answered in the Console before our send landed).
        return {
          action: this.patchAction(a.id, {
            status: result === 'allow' ? 'approved' : 'denied',
            decision: result,
            decisionReason: 'external',
            decidedBy: null,
          }),
          wasOurs: false,
        };
      }
      return { action: this.patchAction(a.id, { status: finalStatus(a.decision, a.decisionReason) }), wasOurs: true };
    }
    if (a.status === 'pending') {
      return {
        action: this.patchAction(a.id, {
          status: result === 'allow' ? 'approved' : 'denied',
          decision: result,
          decisionReason: 'external',
          decidedBy: null,
          decidedAt: at,
        }),
        wasOurs: false,
      };
    }
    return null;
  }
  async listExpired(now: Date, limit: number): Promise<PendingAction[]> {
    return (await this.listPendingActions(['pending'], Number.MAX_SAFE_INTEGER))
      .filter((a) => a.expiresAt <= now)
      .slice(0, limit);
  }
  async listStuckDeciding(olderThan: Date, limit: number): Promise<PendingAction[]> {
    return (await this.listPendingActions(['deciding'], Number.MAX_SAFE_INTEGER))
      .filter((a) => a.updatedAt < olderThan)
      .slice(0, limit);
  }
  async voidPendingForRun(runId: string): Promise<number> {
    let n = 0;
    for (const a of this.actions.values()) {
      if (a.runId === runId && (a.status === 'pending' || a.status === 'deciding')) {
        this.patchAction(a.id, { status: 'void' });
        n += 1;
      }
    }
    return n;
  }

  // ---- internals ----
  private patchRun(id: string, patch: Partial<TeamRun>): void {
    const r = this.runs.get(id);
    if (!r) throw new Error(`unknown run ${id}`);
    this.runs.set(id, { ...r, ...patch, updatedAt: this.now() });
  }
  private patchAction(id: string, patch: Partial<PendingAction>): PendingAction {
    const a = this.actions.get(id);
    if (!a) throw new Error(`unknown action ${id}`);
    const next = { ...a, ...patch, updatedAt: this.now() };
    this.actions.set(id, next);
    return next;
  }
}

function finalStatus(decision: ToolDecision | null, reason: string | null): PendingStatus {
  if (decision === 'allow') return 'approved';
  if (reason === 'ttl') return 'expired';
  return 'denied';
}
