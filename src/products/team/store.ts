import type { Pool, PoolClient } from 'pg';
import type {
  DecisionClaim,
  DecisionReason,
  NewPendingAction,
  NewRun,
  PendingAction,
  PendingStatus,
  PortalInput,
  PortalKind,
  RunStatePatch,
  RunStatus,
  RunTrigger,
  SeenEvent,
  TeamPortal,
  TeamRun,
  TeamStore,
  ToolDecision,
} from './types.js';
import type { TeamAgentSlug } from './catalog.js';

/**
 * Postgres TeamStore (docs/plans/team-control-plane.md M2). All SQL for the
 * team_* tables lives here, parameterised only. Semantics mirror
 * InMemoryTeamStore; store.itest.ts proves both against the real migration.
 *
 * Timestamps we own (updated_at, decided_at) come from the injected clock, so
 * tests can age rows deterministically and the stuck/expiry predicates compare
 * against the same clock the callers use.
 */

const ERROR_CAP = 2000;

// ---------- row shapes ----------
interface PortalRow {
  id: string;
  label: string;
  hubspot_id: string;
  kind: PortalKind;
  vault_id: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RunRow {
  id: string;
  session_id: string | null;
  agent_slug: TeamAgentSlug;
  agent_id: string;
  agent_version: number;
  environment_id: string;
  portal_id: string | null;
  portal_kind: PortalKind | null;
  client_label: string;
  project_ref: string | null;
  task: string;
  started_by: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  stop_reason: string | null;
  budget_cents: number;
  list_cost_cents: number | null;
  last_error: string | null;
  last_event_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ActionRow {
  id: string;
  run_id: string;
  event_id: string;
  thread_id: string | null;
  tool_kind: 'mcp' | 'builtin';
  tool_name: string;
  mcp_server: string | null;
  input: unknown;
  input_truncated: boolean;
  injection_flags: string[];
  portal_id: string | null;
  portal_kind: PortalKind | null;
  status: PendingStatus;
  decision: ToolDecision | null;
  decision_reason: DecisionReason | null;
  deny_message: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  last_error: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

const toPortal = (r: PortalRow): TeamPortal => ({
  id: r.id,
  label: r.label,
  hubspotId: r.hubspot_id,
  kind: r.kind,
  vaultId: r.vault_id,
  enabled: r.enabled,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r: RunRow): TeamRun => ({
  id: r.id,
  sessionId: r.session_id,
  agentSlug: r.agent_slug,
  agentId: r.agent_id,
  agentVersion: r.agent_version,
  environmentId: r.environment_id,
  portalId: r.portal_id,
  portalKind: r.portal_kind,
  clientLabel: r.client_label,
  projectRef: r.project_ref,
  task: r.task,
  startedBy: r.started_by,
  trigger: r.trigger,
  status: r.status,
  stopReason: r.stop_reason,
  budgetCents: r.budget_cents,
  listCostCents: r.list_cost_cents,
  lastError: r.last_error,
  lastEventAt: r.last_event_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toAction = (r: ActionRow): PendingAction => ({
  id: r.id,
  runId: r.run_id,
  eventId: r.event_id,
  threadId: r.thread_id,
  toolKind: r.tool_kind,
  toolName: r.tool_name,
  mcpServer: r.mcp_server,
  input: r.input,
  inputTruncated: r.input_truncated,
  injectionFlags: r.injection_flags,
  portalId: r.portal_id,
  portalKind: r.portal_kind,
  status: r.status,
  decision: r.decision,
  decisionReason: r.decision_reason,
  denyMessage: r.deny_message,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  lastError: r.last_error,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// A deciding row resolves by one rule (inlined in the two UPDATEs below, which the
// SQL-safety guard requires to be literal text): allow -> approved, a ttl denial ->
// expired, any other denial -> denied.
export class PgTeamStore implements TeamStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---- portals ----
  async listPortals(): Promise<TeamPortal[]> {
    const { rows } = await this.pool.query<PortalRow>('SELECT * FROM team_portals ORDER BY created_at, id');
    return rows.map(toPortal);
  }

  async getPortal(id: string): Promise<TeamPortal | null> {
    const { rows } = await this.pool.query<PortalRow>('SELECT * FROM team_portals WHERE id = $1', [id]);
    return rows[0] ? toPortal(rows[0]) : null;
  }

  async createPortal(input: PortalInput, actorId: string): Promise<TeamPortal> {
    const t = this.now();
    const { rows } = await this.pool.query<PortalRow>(
      `INSERT INTO team_portals (label, hubspot_id, kind, vault_id, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $6)
       RETURNING *`,
      [input.label, input.hubspotId, input.kind, input.vaultId, actorId, t],
    );
    return toPortal(rows[0]!);
  }

  async setPortalEnabled(id: string, enabled: boolean, actorId: string): Promise<TeamPortal | null> {
    const { rows } = await this.pool.query<PortalRow>(
      `UPDATE team_portals SET enabled = $2, updated_by = $3, updated_at = $4
       WHERE id = $1
       RETURNING *`,
      [id, enabled, actorId, this.now()],
    );
    return rows[0] ? toPortal(rows[0]) : null;
  }

  // ---- runs ----
  async insertRun(input: NewRun): Promise<TeamRun> {
    const t = this.now();
    const { rows } = await this.pool.query<RunRow>(
      `INSERT INTO team_runs
         (agent_slug, agent_id, agent_version, environment_id, portal_id, portal_kind, client_label,
          project_ref, task, started_by, trigger, budget_cents, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'starting', $13, $13)
       RETURNING *`,
      [
        input.agentSlug,
        input.agentId,
        input.agentVersion,
        input.environmentId,
        input.portalId,
        input.portalKind,
        input.clientLabel,
        input.projectRef,
        input.task,
        input.startedBy,
        input.trigger,
        input.budgetCents,
        t,
      ],
    );
    return toRun(rows[0]!);
  }

  async attachSession(runId: string, sessionId: string, status: RunStatus): Promise<void> {
    const res = await this.pool.query(
      'UPDATE team_runs SET session_id = $2, status = $3, updated_at = $4 WHERE id = $1',
      [runId, sessionId, status, this.now()],
    );
    if ((res.rowCount ?? 0) === 0) throw new Error(`unknown run ${runId}`);
  }

  async markRunFailed(runId: string, error: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE team_runs SET status = 'failed', last_error = $2, updated_at = $3 WHERE id = $1`,
      [runId, error.slice(0, ERROR_CAP), this.now()],
    );
    if ((res.rowCount ?? 0) === 0) throw new Error(`unknown run ${runId}`);
  }

  async getRun(id: string): Promise<TeamRun | null> {
    const { rows } = await this.pool.query<RunRow>('SELECT * FROM team_runs WHERE id = $1', [id]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listRuns(limit: number): Promise<TeamRun[]> {
    const { rows } = await this.pool.query<RunRow>('SELECT * FROM team_runs ORDER BY created_at DESC, id LIMIT $1', [
      limit,
    ]);
    return rows.map(toRun);
  }

  async listStreamableRuns(idleCutoff: Date): Promise<TeamRun[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT * FROM team_runs
       WHERE session_id IS NOT NULL
         AND (status IN ('starting', 'running', 'requires_action', 'budget_reached', 'rescheduling')
              OR (status = 'idle' AND updated_at > $1))
       ORDER BY created_at, id`,
      [idleCutoff],
    );
    return rows.map(toRun);
  }

  async updateRunState(runId: string, patch: RunStatePatch): Promise<void> {
    // One fixed statement: a boolean flag per column says whether the patch
    // carries it, so nullable columns can be set to NULL explicitly while an
    // absent key leaves the column alone.
    const res = await this.pool.query(
      `UPDATE team_runs SET
         status          = CASE WHEN $2  THEN $3  ELSE status END,
         stop_reason     = CASE WHEN $4  THEN $5  ELSE stop_reason END,
         list_cost_cents = CASE WHEN $6  THEN $7  ELSE list_cost_cents END,
         budget_cents    = CASE WHEN $8  THEN $9  ELSE budget_cents END,
         last_error      = CASE WHEN $10 THEN $11 ELSE last_error END,
         last_event_at   = CASE WHEN $12 THEN $13 ELSE last_event_at END,
         updated_at      = $14
       WHERE id = $1`,
      [
        runId,
        patch.status !== undefined,
        patch.status ?? null,
        'stopReason' in patch,
        patch.stopReason ?? null,
        'listCostCents' in patch,
        patch.listCostCents ?? null,
        patch.budgetCents !== undefined,
        patch.budgetCents ?? null,
        'lastError' in patch,
        patch.lastError ?? null,
        patch.lastEventAt !== undefined,
        patch.lastEventAt ?? null,
        this.now(),
      ],
    );
    if ((res.rowCount ?? 0) === 0) throw new Error(`unknown run ${runId}`);
  }

  // ---- event ledger ----
  async hasSeenEvent(eventKey: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM team_run_events WHERE event_key = $1', [eventKey]);
    return (rowCount ?? 0) > 0;
  }

  async markEventSeen(entry: SeenEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO team_run_events (event_key, run_id, event_type, thread_id, processed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_key) DO NOTHING`,
      [entry.eventKey, entry.runId, entry.eventType, entry.threadId, entry.processedAt],
    );
  }

  // ---- pending actions ----
  async insertPendingAction(input: NewPendingAction): Promise<{ inserted: boolean; action: PendingAction }> {
    const t = this.now();
    const ins = await this.pool.query<ActionRow>(
      `INSERT INTO team_pending_actions
         (run_id, event_id, thread_id, tool_kind, tool_name, mcp_server, input, input_truncated,
          injection_flags, portal_id, portal_kind, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $13)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *`,
      [
        input.runId,
        input.eventId,
        input.threadId,
        input.toolKind,
        input.toolName,
        input.mcpServer,
        JSON.stringify(input.input ?? null),
        input.inputTruncated,
        input.injectionFlags,
        input.portalId,
        input.portalKind,
        input.expiresAt,
        t,
      ],
    );
    if (ins.rows[0]) return { inserted: true, action: toAction(ins.rows[0]) };
    const { rows } = await this.pool.query<ActionRow>('SELECT * FROM team_pending_actions WHERE event_id = $1', [
      input.eventId,
    ]);
    return { inserted: false, action: toAction(rows[0]!) };
  }

  async getPendingAction(id: string): Promise<PendingAction | null> {
    const { rows } = await this.pool.query<ActionRow>('SELECT * FROM team_pending_actions WHERE id = $1', [id]);
    return rows[0] ? toAction(rows[0]) : null;
  }

  async listPendingActions(statuses: readonly PendingStatus[], limit: number): Promise<PendingAction[]> {
    const { rows } = await this.pool.query<ActionRow>(
      `SELECT * FROM team_pending_actions
       WHERE status = ANY($1::text[])
       ORDER BY created_at, id
       LIMIT $2`,
      [statuses, limit],
    );
    return rows.map(toAction);
  }

  async listPendingForRun(runId: string): Promise<PendingAction[]> {
    const { rows } = await this.pool.query<ActionRow>(
      'SELECT * FROM team_pending_actions WHERE run_id = $1 ORDER BY created_at, id',
      [runId],
    );
    return rows.map(toAction);
  }

  async claimDecision(id: string, claim: DecisionClaim): Promise<PendingAction | null> {
    // One conditional UPDATE: under READ COMMITTED a concurrent claimer
    // re-checks status after the winner commits and matches no row.
    const t = this.now();
    const { rows } = await this.pool.query<ActionRow>(
      `UPDATE team_pending_actions
       SET status = 'deciding', decision = $2, decision_reason = $3, decided_by = $4,
           deny_message = $5, decided_at = $6, updated_at = $6
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, claim.decision, claim.reason, claim.decidedBy, claim.denyMessage, t],
    );
    return rows[0] ? toAction(rows[0]) : null;
  }

  async finalizeDecision(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE team_pending_actions SET status = CASE WHEN decision = 'allow' THEN 'approved'
                          WHEN decision_reason = 'ttl' THEN 'expired'
                          ELSE 'denied' END, updated_at = $2
       WHERE id = $1 AND status = 'deciding'`,
      [id, this.now()],
    );
  }

  async revertDecision(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE team_pending_actions
       SET status = 'pending', decision = NULL, decision_reason = NULL, decided_by = NULL,
           deny_message = NULL, decided_at = NULL, last_error = $2, updated_at = $3
       WHERE id = $1 AND status = 'deciding'`,
      [id, error.slice(0, ERROR_CAP), this.now()],
    );
  }

  async settleFromEcho(
    toolUseId: string,
    result: ToolDecision,
    at: Date,
  ): Promise<{ action: PendingAction; wasOurs: boolean } | null> {
    return this.inTx(async (c) => {
      const cur = await c.query<ActionRow>('SELECT * FROM team_pending_actions WHERE event_id = $1 FOR UPDATE', [
        toolUseId,
      ]);
      const row = cur.rows[0];
      if (!row) return null;
      const t = this.now();
      if (row.status === 'deciding') {
        const upd = await c.query<ActionRow>(
          `UPDATE team_pending_actions SET status = CASE WHEN decision = 'allow' THEN 'approved'
                          WHEN decision_reason = 'ttl' THEN 'expired'
                          ELSE 'denied' END, updated_at = $2
           WHERE id = $1 RETURNING *`,
          [row.id, t],
        );
        return { action: toAction(upd.rows[0]!), wasOurs: true };
      }
      if (row.status === 'pending') {
        const upd = await c.query<ActionRow>(
          `UPDATE team_pending_actions
           SET status = $2, decision = $3, decision_reason = 'external', decided_by = NULL,
               decided_at = $4, updated_at = $5
           WHERE id = $1 RETURNING *`,
          [row.id, result === 'allow' ? 'approved' : 'denied', result, at, t],
        );
        return { action: toAction(upd.rows[0]!), wasOurs: false };
      }
      return null;
    });
  }

  async listExpired(now: Date, limit: number): Promise<PendingAction[]> {
    const { rows } = await this.pool.query<ActionRow>(
      `SELECT * FROM team_pending_actions
       WHERE status = 'pending' AND expires_at <= $1
       ORDER BY created_at, id
       LIMIT $2`,
      [now, limit],
    );
    return rows.map(toAction);
  }

  async listStuckDeciding(olderThan: Date, limit: number): Promise<PendingAction[]> {
    const { rows } = await this.pool.query<ActionRow>(
      `SELECT * FROM team_pending_actions
       WHERE status = 'deciding' AND updated_at < $1
       ORDER BY created_at, id
       LIMIT $2`,
      [olderThan, limit],
    );
    return rows.map(toAction);
  }

  async voidPendingForRun(runId: string): Promise<number> {
    const res = await this.pool.query(
      `UPDATE team_pending_actions SET status = 'void', updated_at = $2
       WHERE run_id = $1 AND status IN ('pending', 'deciding')`,
      [runId, this.now()],
    );
    return res.rowCount ?? 0;
  }

  // ---- internals ----
  private async inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
