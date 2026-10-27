import { sanitize } from '../../core/agents/sanitize.js';
import { SeparationOfDutiesError } from '../../console/rbac/sod.js';
import { log } from '../../core/obs/logger.js';
import {
  DENY_MESSAGES,
  TEAM_PERMS,
  TeamError,
  hasTeamPerm,
  sodSubject,
  type DecideInput,
  type DecisionReason,
  type GateDeps,
  type GateOutcome,
  type PendingAction,
  type TeamGate,
  type TeamRun,
  type ToolDecision,
} from './types.js';

const SWEEP_PENDING_LIMIT = 500;
const SWEEP_EXPIRED_LIMIT = 100;
const STUCK_LIMIT = 100;
const STUCK_AFTER_MS = 5 * 60_000;
// A failed send reverts the row to pending with last_error set; system sweeps retry
// it at most this often so a dead session is not hammered (and audited) every tick.
const RETRY_BACKOFF_MS = 10 * 60_000;

interface Resolution {
  result: ToolDecision;
  reason: DecisionReason;
  denyMessage: string | null;
  decidedBy: string | null;
  forced: boolean;
  selfApproved: boolean;
}

/**
 * The approval gate: every decision on a pending ask (human, TTL, kill-switch,
 * portal disabled) goes through here. The store's atomic claimDecision is the
 * only mutual exclusion, so two concurrent callers can never both send.
 */
export function createTeamGate(deps: GateDeps): TeamGate {
  const { store, client, audit, sod, isWritesFrozen, now } = deps;

  async function voidRun(action: PendingAction): Promise<GateOutcome> {
    await store.voidPendingForRun(action.runId);
    return { actionId: action.id, status: 'void', reason: 'approver', forced: true };
  }

  /** Steps 6-8: claim, send, finalize, evidence. Shared by humans and the system. */
  async function settle(run: TeamRun, action: PendingAction, r: Resolution, actorId: string | null): Promise<GateOutcome> {
    if (!run.sessionId) throw new TeamError('run_not_active', 'run has no session to answer');

    const claimed = await store.claimDecision(action.id, {
      decision: r.result,
      reason: r.reason,
      decidedBy: r.decidedBy,
      denyMessage: r.denyMessage,
    });
    if (!claimed) throw new TeamError('action_already_decided', 'this action was already decided');

    const base = { actionId: action.id, eventId: action.eventId, toolName: action.toolName, portalKind: action.portalKind };
    try {
      await client.sendToolConfirmation(run.sessionId, {
        toolUseId: action.eventId,
        result: r.result,
        denyMessage: r.result === 'deny' ? r.denyMessage : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await store.revertDecision(action.id, msg.slice(0, 2000));
      await audit({
        eventType: 'team_action_decided',
        product: 'team',
        actorId,
        subjectId: run.id,
        payload: { ...base, outcome: 'send_failed', result: r.result, reason: r.reason, error: msg.slice(0, 500) },
      });
      throw err;
    }

    await store.finalizeDecision(action.id);
    if (actorId) {
      await sod.record({
        subjectId: sodSubject.action(action.id),
        action: r.result === 'allow' ? 'approved' : 'rejected',
        actorId,
      });
    }
    await audit({
      eventType: 'team_action_decided',
      product: 'team',
      actorId,
      subjectId: run.id,
      payload: { ...base, result: r.result, reason: r.reason, forced: r.forced, selfApproved: r.selfApproved },
    });
    const status = r.reason === 'ttl' ? 'expired' : r.result === 'allow' ? 'approved' : 'denied';
    return { actionId: action.id, status, reason: r.reason, forced: r.forced };
  }

  async function decideAsSystem(action: PendingAction, reason: DecisionReason): Promise<GateOutcome | null> {
    if (action.lastError && now().getTime() - action.updatedAt.getTime() < RETRY_BACKOFF_MS) return null;
    const run = await store.getRun(action.runId);
    if (!run || run.status === 'terminated') return voidRun(action);
    return settle(
      run,
      action,
      { result: 'deny', reason, denyMessage: DENY_MESSAGES[reason], decidedBy: null, forced: false, selfApproved: false },
      null,
    );
  }

  /** Sweep helper: one failed or lost action must not stop the rest. */
  async function sweep(actions: PendingAction[], reason: DecisionReason): Promise<number> {
    let n = 0;
    for (const a of actions) {
      try {
        if (await decideAsSystem(a, reason)) n++;
      } catch (err) {
        if (err instanceof TeamError && err.code === 'action_already_decided') continue;
        log().warn({ err, actionId: a.id, reason }, 'team gate: system decision failed');
      }
    }
    return n;
  }

  async function portalDisabled(action: PendingAction): Promise<boolean> {
    if (!action.portalId) return false;
    const portal = await store.getPortal(action.portalId);
    return portal !== null && !portal.enabled;
  }

  return {
    async decide(input: DecideInput): Promise<GateOutcome> {
      const { actionId, actor } = input;
      const action = await store.getPendingAction(actionId);
      if (!action) throw new TeamError('action_not_found', 'no such action');
      if (action.status !== 'pending') throw new TeamError('action_already_decided', 'this action was already decided');

      const run = await store.getRun(action.runId);
      if (!run || run.status === 'terminated') return voidRun(action);

      const production = action.portalKind === 'production';
      const perm = production ? TEAM_PERMS.approveProduction : TEAM_PERMS.approve;
      if (!hasTeamPerm(actor, perm)) throw new TeamError('permission_denied', `requires ${perm}`);

      // Separation of duties applies to production asks only (owner decision Q3).
      // Denying is the safe direction and is never blocked.
      if (input.result === 'allow' && production) {
        try {
          await sod.assertApprovalAllowed(actor.id, sodSubject.run(run.id));
          if (action.portalId) await sod.assertApprovalAllowed(actor.id, sodSubject.portal(action.portalId));
        } catch (err) {
          if (err instanceof SeparationOfDutiesError) throw new TeamError('sod_denied', err.message);
          throw err;
        }
      }
      const selfApproved = input.result === 'allow' && !production && run.startedBy !== null && run.startedBy === actor.id;

      let result: ToolDecision = input.result;
      let reason: DecisionReason = 'approver';
      let forced = false;
      let denyMessage: string | null = null;
      if (result === 'allow') {
        if (await isWritesFrozen()) {
          result = 'deny';
          reason = 'kill_switch';
          forced = true;
        } else if (await portalDisabled(action)) {
          result = 'deny';
          reason = 'portal_disabled';
          forced = true;
        }
      }
      if (result === 'deny') {
        denyMessage = forced
          ? DENY_MESSAGES[reason]
          : sanitize(input.denyMessage ?? '', { maxLength: 1000 }).trim() || DENY_MESSAGES.approver;
      }

      return settle(run, action, { result, reason, denyMessage, decidedBy: actor.id, forced, selfApproved }, actor.id);
    },

    async onNewAsk(action: PendingAction): Promise<void> {
      if (await isWritesFrozen()) {
        await decideAsSystem(action, 'kill_switch');
      } else if (await portalDisabled(action)) {
        await decideAsSystem(action, 'portal_disabled');
      }
    },

    async expireStale(): Promise<number> {
      return sweep(await store.listExpired(now(), SWEEP_EXPIRED_LIMIT), 'ttl');
    },

    async enforceKillSwitch(): Promise<number> {
      return sweep(await store.listPendingActions(['pending'], SWEEP_PENDING_LIMIT), 'kill_switch');
    },

    async reconcileStuck(): Promise<number> {
      const stuck = await store.listStuckDeciding(new Date(now().getTime() - STUCK_AFTER_MS), STUCK_LIMIT);
      for (const a of stuck) {
        await store.revertDecision(a.id, 'confirmation not echoed within 5 minutes');
      }
      if (stuck.length > 0) log().warn({ count: stuck.length }, 'team gate: reverted stuck deciding actions');
      return stuck.length;
    },
  };
}
