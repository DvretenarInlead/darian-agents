import { sanitize } from '../../core/agents/sanitize.js';
import { TEAM_AGENT_CATALOG, type TeamAgentSpec } from './catalog.js';
import { loadTeamBudgets, resolveBudgetCents } from './budgets.js';
import { buildRunHeader } from './header.js';
import { normalizeSlug } from './lockfile.js';
import {
  FollowUpText,
  StartRunInput,
  TeamError,
  mapSessionStatus,
  sodSubject,
  type LauncherDeps,
  type TeamLauncher,
  type TeamRun,
} from './types.js';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 2000);

/**
 * Run lifecycle actions (start, follow-up, interrupt, raise budget). Every
 * check that can refuse runs before the first external call, so a refusal never
 * leaves a session or a run row behind.
 */
export function createTeamLauncher(deps: LauncherDeps): TeamLauncher {
  const { store, client, audit, sod, now } = deps;

  async function mustGetRun(runId: string): Promise<TeamRun> {
    const run = await store.getRun(runId);
    if (!run) throw new TeamError('run_not_found', 'run not found');
    return run;
  }

  async function refuseIfFrozen(spec: TeamAgentSpec): Promise<void> {
    if (spec.writes && (await deps.isWritesFrozen())) {
      throw new TeamError('kill_switch', 'External writes are frozen; this role cannot run until the kill-switch is released.');
    }
  }

  async function start(rawInput: StartRunInput): Promise<TeamRun> {
    const parsed = StartRunInput.safeParse(rawInput);
    if (!parsed.success) throw new TeamError('invalid_input', 'invalid run request');
    const input = parsed.data;

    if (!deps.cfg.enabled) throw new TeamError('disabled', 'The PYB Team control plane is not enabled.');

    const spec = TEAM_AGENT_CATALOG[input.agentSlug];
    if (!spec) throw new TeamError('unknown_agent', 'unknown agent');
    if (!spec.launchable) throw new TeamError('not_launchable', `${spec.label} cannot be launched yet.`);

    await refuseIfFrozen(spec);

    const usesHubspot = spec.mcp.includes('hubspot');
    let portal = null;
    if (usesHubspot) {
      if (!input.portalId) throw new TeamError('portal_required', `${spec.label} needs a HubSpot portal.`);
      portal = await store.getPortal(input.portalId);
      if (!portal) throw new TeamError('portal_not_found', 'portal not found');
      if (!portal.enabled) throw new TeamError('portal_disabled', 'This portal is disabled for agent work.');
      if (!spec.allowedPortalKinds.includes(portal.kind)) {
        throw new TeamError('portal_kind_not_allowed', `${spec.label} cannot run against a ${portal.kind} portal.`);
      }
    } else if (input.portalId !== null) {
      throw new TeamError('invalid_input', `${spec.label} does not use a portal.`);
    }

    const lock = await deps.lockStatus();
    if (!lock.ok) throw new TeamError('lockfile_missing', `claude-lock.json is not usable: ${lock.reason}`);
    const lockedAgent = lock.agents[normalizeSlug(spec.slug)];
    if (!lockedAgent) throw new TeamError('lockfile_agent_missing', `${spec.label} is not in claude-lock.json.`);
    const lockedEnv = lock.environments[normalizeSlug(spec.environment)];
    if (!lockedEnv) throw new TeamError('environment_missing', `Environment ${spec.environment} is not in claude-lock.json.`);

    // Shared vaults are optional (owner decision): an unset one is simply not attached.
    const vaultIds: string[] = [];
    const vaultsMissing: string[] = [];
    if (portal) vaultIds.push(portal.vaultId);
    if (spec.mcp.includes('fireflies')) {
      if (deps.cfg.firefliesVaultId) vaultIds.push(deps.cfg.firefliesVaultId);
      else vaultsMissing.push('fireflies');
    }
    if (spec.mcp.includes('github')) {
      if (deps.cfg.githubVaultId) vaultIds.push(deps.cfg.githubVaultId);
      else vaultsMissing.push('github');
    }

    const budgetCents = resolveBudgetCents(await loadTeamBudgets(deps.pool), spec.slug, deps.cfg);

    const run = await store.insertRun({
      agentSlug: spec.slug,
      agentId: lockedAgent.id,
      agentVersion: lockedAgent.version,
      environmentId: lockedEnv.id,
      portalId: portal?.id ?? null,
      portalKind: portal?.kind ?? null,
      clientLabel: sanitize(input.clientLabel, { maxLength: 120 }).replace(/[\r\n]+/g, ' ').trim() || 'PYB',
      projectRef: input.projectRef,
      task: input.task,
      startedBy: input.startedBy,
      trigger: input.trigger,
      budgetCents,
    });
    await sod.record({ subjectId: sodSubject.run(run.id), action: 'configured', actorId: input.startedBy });

    let session;
    try {
      session = await client.createSession({
        agentId: lockedAgent.id,
        agentVersion: lockedAgent.version,
        environmentId: lockedEnv.id,
        vaultIds,
        budgetCents,
        title: `PYB ${spec.slug} ${run.id.slice(0, 8)}`,
        metadata: { team_run_id: run.id, portal_kind: portal?.kind ?? 'none' },
      });
    } catch (e) {
      await store.markRunFailed(run.id, errMsg(e));
      await audit({
        eventType: 'team_run_failed',
        product: 'team',
        actorId: input.startedBy,
        subjectId: run.id,
        payload: { stage: 'create', error: errMsg(e) },
      });
      throw e;
    }

    await store.attachSession(run.id, session.id, mapSessionStatus(session.status));

    try {
      await client.sendUserMessage(
        session.id,
        buildRunHeader({
          spec,
          portal: portal ? { hubspotId: portal.hubspotId, kind: portal.kind } : null,
          clientLabel: run.clientLabel,
          projectRef: input.projectRef,
          inputs: input.inputs,
          acceptanceCriteria: input.acceptanceCriteria,
          task: input.task,
        }),
      );
    } catch (e) {
      // The session exists, so leave it idle and let an operator retry with a follow-up.
      await store.updateRunState(run.id, { status: 'idle', lastError: errMsg(e) });
      await audit({
        eventType: 'team_run_failed',
        product: 'team',
        actorId: input.startedBy,
        subjectId: run.id,
        payload: { stage: 'kickoff', sessionId: session.id, error: errMsg(e) },
      });
      throw e;
    }

    await audit({
      eventType: 'team_run_started',
      product: 'team',
      actorId: input.startedBy,
      subjectId: run.id,
      payload: {
        agentSlug: spec.slug,
        agentId: lockedAgent.id,
        agentVersion: lockedAgent.version,
        sessionId: session.id,
        portalId: portal?.id ?? null,
        portalKind: portal?.kind ?? null,
        budgetCents,
        vaultsMissing,
        at: now().toISOString(),
      },
    });
    const started = await store.getRun(run.id);
    if (!started) throw new TeamError('run_not_found', 'run vanished after start');
    return started;
  }

  async function followUp(input: { runId: string; text: string; actorId: string }): Promise<void> {
    const text = FollowUpText.safeParse(input.text);
    if (!text.success) throw new TeamError('invalid_input', 'follow-up text must be 1–20000 characters');
    const run = await mustGetRun(input.runId);
    if (!run.sessionId || run.status === 'terminated' || run.status === 'failed') {
      throw new TeamError('run_not_active', 'This run has ended.');
    }
    if (run.status === 'requires_action' || run.status === 'budget_reached') {
      throw new TeamError('run_busy', `This run is waiting (${run.status}); resolve that first.`);
    }
    await refuseIfFrozen(TEAM_AGENT_CATALOG[run.agentSlug]);

    const statusBeforeSend = run.status;
    await client.sendUserMessage(run.sessionId, sanitize(text.data, { maxLength: 20_000 }));
    // 'running' makes the supervisor reopen the stream if it had closed on idle. Only
    // write it if nothing newer landed meanwhile (the stream may already have moved the
    // run to requires_action/terminated while the send was in flight).
    const after = await store.getRun(run.id);
    if (after && after.status === statusBeforeSend) await store.updateRunState(run.id, { status: 'running' });
    await sod.record({ subjectId: sodSubject.run(run.id), action: 'configured', actorId: input.actorId });
    await audit({
      eventType: 'team_run_message',
      product: 'team',
      actorId: input.actorId,
      subjectId: run.id,
      payload: { length: text.data.length },
    });
  }

  async function interrupt(input: { runId: string; actorId: string }): Promise<void> {
    // Stopping work is always allowed, including while the kill-switch is on.
    const run = await mustGetRun(input.runId);
    if (!run.sessionId || run.status === 'terminated') {
      throw new TeamError('run_not_active', 'This run has no active session.');
    }
    await client.interrupt(run.sessionId);
    await audit({
      eventType: 'team_run_interrupted',
      product: 'team',
      actorId: input.actorId,
      subjectId: run.id,
      payload: {},
    });
  }

  async function raiseBudget(input: { runId: string; newCents: number; actorId: string }): Promise<TeamRun> {
    const run = await mustGetRun(input.runId);
    if (!run.sessionId || run.status === 'terminated' || run.status === 'failed') {
      throw new TeamError('run_not_active', 'This run has ended.');
    }
    const { newCents } = input;
    if (!Number.isInteger(newCents) || newCents <= (run.listCostCents ?? 0) || newCents <= run.budgetCents || newCents > deps.cfg.maxBudgetCents) {
      throw new TeamError(
        'budget_invalid',
        `Budget must be a whole number of cents above the current budget and cost, and at most ${deps.cfg.maxBudgetCents}.`,
      );
    }
    await refuseIfFrozen(TEAM_AGENT_CATALOG[run.agentSlug]);

    await client.updateBudget(run.sessionId, newCents);
    // budget_reached would otherwise be a dead end: reopen the stream and let the
    // operator follow up (the API applies the new budget from the next turn).
    await store.updateRunState(
      run.id,
      run.status === 'budget_reached'
        ? { status: 'idle', stopReason: null, budgetCents: newCents }
        : { budgetCents: newCents },
    );
    await audit({
      eventType: 'team_budget_changed',
      product: 'team',
      actorId: input.actorId,
      subjectId: run.id,
      payload: { fromCents: run.budgetCents, toCents: newCents },
    });
    return mustGetRun(run.id);
  }

  return { start, followUp, interrupt, raiseBudget };
}
