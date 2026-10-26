import { log } from '../../core/obs/logger.js';
import { runStream } from './stream.js';
import type { SupervisorDeps, TeamRun, TeamSupervisor } from './types.js';

/**
 * Leader-side loop (the worker holds the advisory lock around run()). Keeps one
 * stream per streamable run, enforces the kill-switch on every tick and does the
 * slower housekeeping (TTL expiry, stuck decisions, missed terminal events).
 */

interface Connection {
  controller: AbortController;
  done: Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createTeamSupervisor(deps: SupervisorDeps): TeamSupervisor {
  const tickMs = deps.tickMs ?? 5_000;
  const housekeepingMs = deps.housekeepingMs ?? 60_000;
  const sleep = deps.sleep ?? defaultSleep;

  return {
    async run(stopped) {
      const connections = new Map<string, Connection>();
      let listed: TeamRun[] = [];
      let lastHousekeeping: number | null = null;

      const connect = (run: TeamRun) => {
        const controller = new AbortController();
        const done = runStream({ ...deps, sleep }, run, controller.signal)
          .catch((err) => log().error({ runId: run.id, err: String(err) }, 'team stream loop crashed'))
          .finally(() => {
            // Only clear our own entry: a re-listed run may already have a new one.
            if (connections.get(run.id)?.controller === controller) connections.delete(run.id);
          });
        connections.set(run.id, { controller, done });
      };

      const tick = async () => {
        const cutoff = new Date(deps.now().getTime() - deps.cfg.streamIdleCloseMin * 60_000);
        listed = await deps.store.listStreamableRuns(cutoff);
        const ids = new Set(listed.map((r) => r.id));
        for (const run of listed) if (!connections.has(run.id)) connect(run);
        for (const [id, c] of connections) {
          if (!ids.has(id)) {
            c.controller.abort();
            connections.delete(id);
          }
        }
        if (await deps.isWritesFrozen()) await deps.gate.enforceKillSwitch();
      };

      const housekeeping = async () => {
        await deps.gate.expireStale();
        await deps.gate.reconcileStuck();
        for (const run of listed) {
          if (!run.sessionId) continue;
          try {
            const session = await deps.client.retrieveSession(run.sessionId);
            const current = await deps.store.getRun(run.id);
            if (!current) continue;
            if (session.status === 'terminated' && current.status !== 'terminated') {
              await deps.store.updateRunState(run.id, { status: 'terminated' });
              await deps.store.voidPendingForRun(run.id);
            }
            if (session.listCostCents !== null && session.listCostCents !== current.listCostCents) {
              await deps.store.updateRunState(run.id, { listCostCents: session.listCostCents });
            }
          } catch (err) {
            if ((err as { status?: unknown } | null)?.status === 404) {
              // Session deleted out from under us: no more events will ever arrive.
              await deps.store.updateRunState(run.id, { status: 'terminated' });
              await deps.store.voidPendingForRun(run.id);
              continue;
            }
            log().warn({ runId: run.id, err: String(err) }, 'team housekeeping: retrieveSession failed');
          }
        }
      };

      const guarded = async (what: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          log().error({ err: String(err) }, `team supervisor ${what} failed`);
        }
      };

      try {
        while (!stopped()) {
          await guarded('tick', tick);
          const nowMs = deps.now().getTime();
          if (lastHousekeeping === null || nowMs - lastHousekeeping >= housekeepingMs) {
            lastHousekeeping = nowMs;
            await guarded('housekeeping', housekeeping);
          }
          if (stopped()) break;
          if (deps.sleep) await deps.sleep(tickMs);
          else for (let w = 0; w < tickMs && !stopped(); w += 500) await sleep(Math.min(500, tickMs - w)); // prompt shutdown
        }
      } finally {
        const open = [...connections.values()];
        for (const c of open) c.controller.abort();
        connections.clear();
        await Promise.all(open.map((c) => c.done));
      }
    },
  };
}
