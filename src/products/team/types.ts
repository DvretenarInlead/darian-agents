import { z } from 'zod';
import type { Pool } from 'pg';
import { appendAudit, type AuditEvent } from '../../core/audit/writer.js';
import { assertApprovalAllowed, recordSodAction, type SodEntry } from '../../console/rbac/sod.js';
import type { Config } from '../../config/index.js';
import type { ManagedAgentsClient } from '../../integrations/anthropic/managedAgents.js';
import { TEAM_AGENT_SLUGS, type TeamAgentSlug } from './catalog.js';

/**
 * Shared contracts for the PYB Team control plane (docs/plans/team-control-plane.md §3.1).
 * Every team module imports from here and none edits it: the launcher, store,
 * gate, stream supervisor and console panel are built in parallel against
 * these names.
 */

// ---------- enums ----------
export const PORTAL_KINDS = ['production', 'sandbox', 'test'] as const;
export type PortalKind = (typeof PORTAL_KINDS)[number];

export const RUN_STATUSES = [
  'starting',
  'running',
  'idle',
  'requires_action',
  'budget_reached',
  'rescheduling',
  'terminated',
  'failed',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['console', 'voice', 'mcp', 'fireflies'] as const; // phases 1–2 only use 'console'
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const PENDING_STATUSES = ['pending', 'deciding', 'approved', 'denied', 'expired', 'void'] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

export const DECISION_REASONS = ['approver', 'ttl', 'kill_switch', 'portal_disabled', 'external'] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

export type ToolDecision = 'allow' | 'deny';

// ---------- permissions + SoD subjects ----------
export const TEAM_PERMS = {
  view: 'team:view',
  run: 'team:run',
  approve: 'team:approve', // sandbox/test (and portal-less) asks
  approveProduction: 'team:approve_production', // asks on the production portal
  portals: 'team:portals', // portals + team_budgets settings
  budget: 'team:budget', // raise a session budget
} as const;

export interface TeamActor {
  id: string;
  permissions: string[];
}
export function hasTeamPerm(actor: TeamActor, perm: string): boolean {
  return actor.permissions.includes('*') || actor.permissions.includes(perm);
}

export const sodSubject = {
  run: (runId: string) => `team_run:${runId}`,
  portal: (portalId: string) => `team_portal:${portalId}`,
  action: (actionId: string) => `team_action:${actionId}`,
} as const;

export const DENY_MESSAGES: Record<DecisionReason, string> = {
  approver: 'Denied by a PYB approver.',
  ttl: 'Denied automatically: no approval within the allowed time. Ask again if still needed.',
  kill_switch: 'Denied: PYB has frozen all external writes (incident kill-switch). Do not retry; report back.',
  portal_disabled: 'Denied: this HubSpot portal has been disabled for agent work. Do not retry; report back.',
  external: 'Decided outside the PYB console.',
};

// ---------- domain rows ----------
export interface TeamPortal {
  id: string;
  label: string;
  hubspotId: string;
  kind: PortalKind;
  vaultId: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamRun {
  id: string;
  sessionId: string | null;
  agentSlug: TeamAgentSlug;
  agentId: string;
  agentVersion: number;
  environmentId: string;
  portalId: string | null;
  portalKind: PortalKind | null;
  clientLabel: string;
  projectRef: string | null;
  task: string;
  startedBy: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  stopReason: string | null;
  budgetCents: number;
  listCostCents: number | null;
  lastError: string | null;
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PendingAction {
  id: string;
  runId: string;
  eventId: string; // the agent.(mcp_)tool_use event id == tool_use_id for the confirmation
  threadId: string | null; // session_thread_id for cross-posted subagent asks
  toolKind: 'mcp' | 'builtin';
  toolName: string;
  mcpServer: string | null;
  input: unknown; // model-produced; data only, capped
  inputTruncated: boolean;
  injectionFlags: string[];
  portalId: string | null;
  portalKind: PortalKind | null;
  status: PendingStatus;
  decision: ToolDecision | null;
  decisionReason: DecisionReason | null;
  denyMessage: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  lastError: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ---------- store inputs ----------
export interface NewRun {
  agentSlug: TeamAgentSlug;
  agentId: string;
  agentVersion: number;
  environmentId: string;
  portalId: string | null;
  portalKind: PortalKind | null;
  clientLabel: string;
  projectRef: string | null;
  task: string;
  startedBy: string | null;
  trigger: RunTrigger;
  budgetCents: number;
}

export interface RunStatePatch {
  status?: RunStatus;
  stopReason?: string | null;
  listCostCents?: number | null;
  budgetCents?: number;
  lastError?: string | null;
  lastEventAt?: Date;
}

export interface SeenEvent {
  eventKey: string;
  runId: string;
  eventType: string;
  threadId: string | null;
  processedAt: Date | null;
}

export interface NewPendingAction {
  runId: string;
  eventId: string;
  threadId: string | null;
  toolKind: 'mcp' | 'builtin';
  toolName: string;
  mcpServer: string | null;
  input: unknown;
  inputTruncated: boolean;
  injectionFlags: string[];
  portalId: string | null;
  portalKind: PortalKind | null;
  expiresAt: Date;
}

export interface DecisionClaim {
  decision: ToolDecision;
  reason: DecisionReason;
  decidedBy: string | null;
  denyMessage: string | null;
}

// ---------- ports ----------
export interface TeamStore {
  listPortals(): Promise<TeamPortal[]>;
  getPortal(id: string): Promise<TeamPortal | null>;
  createPortal(input: PortalInput, actorId: string): Promise<TeamPortal>;
  setPortalEnabled(id: string, enabled: boolean, actorId: string): Promise<TeamPortal | null>;

  insertRun(input: NewRun): Promise<TeamRun>; // status 'starting', session_id NULL
  attachSession(runId: string, sessionId: string, status: RunStatus): Promise<void>;
  markRunFailed(runId: string, error: string): Promise<void>; // status 'failed', last_error (capped 2000)
  getRun(id: string): Promise<TeamRun | null>;
  listRuns(limit: number): Promise<TeamRun[]>; // newest first
  listStreamableRuns(idleCutoff: Date): Promise<TeamRun[]>;
  updateRunState(runId: string, patch: RunStatePatch): Promise<void>;
  /** Conditional update: apply the patch only if the run's status is in `from`. True if a row changed. */
  transitionRunStatus(
    runId: string,
    from: readonly RunStatus[],
    patch: RunStatePatch & { status: RunStatus },
  ): Promise<boolean>;

  hasSeenEvent(eventKey: string): Promise<boolean>;
  markEventSeen(entry: SeenEvent): Promise<void>; // idempotent

  insertPendingAction(input: NewPendingAction): Promise<{ inserted: boolean; action: PendingAction }>;
  getPendingAction(id: string): Promise<PendingAction | null>;
  listPendingActions(statuses: readonly PendingStatus[], limit: number): Promise<PendingAction[]>; // oldest first
  listPendingForRun(runId: string): Promise<PendingAction[]>;
  claimDecision(id: string, claim: DecisionClaim): Promise<PendingAction | null>; // pending → deciding, atomic
  finalizeDecision(id: string): Promise<void>; // deciding → approved | denied | expired
  revertDecision(id: string, error: string): Promise<void>; // deciding → pending, clears decision, sets last_error
  settleFromEcho(
    toolUseId: string,
    result: ToolDecision,
    at: Date,
  ): Promise<{ action: PendingAction; wasOurs: boolean } | null>;
  listExpired(now: Date, limit: number): Promise<PendingAction[]>; // status 'pending' AND expires_at <= now
  listStuckDeciding(olderThan: Date, limit: number): Promise<PendingAction[]>; // status 'deciding' AND updated_at < olderThan
  voidPendingForRun(runId: string): Promise<number>; // pending|deciding → void
}

export type AuditSink = (event: AuditEvent) => Promise<void>;
export function pgAuditSink(pool: Pool, now: () => Date): AuditSink {
  return async (event) => {
    await appendAudit(pool, event, now().toISOString());
  };
}

export interface SodPort {
  assertApprovalAllowed(actorId: string, subjectId: string): Promise<void>; // throws SeparationOfDutiesError
  record(entry: SodEntry): Promise<void>;
}
export function pgSodPort(pool: Pool): SodPort {
  return {
    assertApprovalAllowed: (actorId, subjectId) => assertApprovalAllowed(pool, actorId, subjectId),
    record: (entry) => recordSodAction(pool, entry),
  };
}

export interface GateOutcome {
  actionId: string;
  status: 'approved' | 'denied' | 'expired' | 'void';
  reason: DecisionReason;
  forced: boolean; // an 'allow' was turned into a deny (kill-switch / portal disabled) or the run was gone
}

export interface DecideInput {
  actionId: string;
  actor: TeamActor;
  result: ToolDecision;
  denyMessage: string | null;
}

export interface TeamGate {
  decide(input: DecideInput): Promise<GateOutcome>;
  onNewAsk(action: PendingAction): Promise<void>;
  expireStale(): Promise<number>;
  enforceKillSwitch(): Promise<number>;
  reconcileStuck(): Promise<number>;
}

export interface TeamLauncher {
  start(input: StartRunInput): Promise<TeamRun>;
  followUp(input: { runId: string; text: string; actorId: string }): Promise<void>;
  interrupt(input: { runId: string; actorId: string }): Promise<void>;
  raiseBudget(input: { runId: string; newCents: number; actorId: string }): Promise<TeamRun>;
}

export interface LockResolution {
  agentId: string;
  agentVersion: number;
  environmentId: string;
}
export type LockfileStatus =
  | {
      ok: true;
      agents: Record<string, { id: string; version: number }>;
      environments: Record<string, { id: string }>;
      warnings: string[];
    }
  | { ok: false; reason: string };

// ---------- module deps ----------
export interface LauncherDeps {
  pool: Pool; // only for loadTeamBudgets
  store: TeamStore;
  client: ManagedAgentsClient;
  audit: AuditSink;
  sod: SodPort;
  isWritesFrozen: () => Promise<boolean>;
  lockStatus: () => Promise<LockfileStatus>;
  cfg: Config['team'];
  now: () => Date;
}

export interface GateDeps {
  store: TeamStore;
  client: ManagedAgentsClient;
  audit: AuditSink;
  sod: SodPort;
  isWritesFrozen: () => Promise<boolean>;
  now: () => Date;
}

export interface StreamDeps {
  store: TeamStore;
  gate: TeamGate;
  audit: AuditSink;
  now: () => Date;
  cfg: Config['team'];
  notify?: (text: string) => Promise<void>;
}

export interface SupervisorDeps extends StreamDeps {
  client: ManagedAgentsClient;
  isWritesFrozen: () => Promise<boolean>;
  tickMs?: number; // default 5_000
  housekeepingMs?: number; // default 60_000
  sleep?: (ms: number) => Promise<void>;
}

export interface TeamSupervisor {
  run(stopped: () => boolean): Promise<void>;
}

export interface ProcessResult {
  duplicate: boolean;
  terminal: boolean;
}

// ---------- validated inputs (console forms → launcher/store) ----------
const numericId = z.string().regex(/^\d{1,20}$/);
export const VAULT_ID_RE = /^vlt_[A-Za-z0-9_-]{1,128}$/;
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/);

export const PortalInput = z.strictObject({
  label: oneLine(120),
  hubspotId: numericId,
  kind: z.enum(PORTAL_KINDS),
  vaultId: z.string().regex(VAULT_ID_RE),
});
export type PortalInput = z.infer<typeof PortalInput>;

export const StartRunInput = z.strictObject({
  agentSlug: z.enum(TEAM_AGENT_SLUGS),
  portalId: z.uuid().nullable(),
  clientLabel: oneLine(120).default('PYB'),
  projectRef: numericId.nullable(),
  task: z.string().trim().min(1).max(20_000),
  inputs: z.string().max(4_000).default(''),
  acceptanceCriteria: z.string().max(4_000).default(''),
  trigger: z.enum(RUN_TRIGGERS),
  startedBy: z.uuid(),
});
export type StartRunInput = z.input<typeof StartRunInput>;

export const FollowUpText = z.string().trim().min(1).max(20_000);
export const DenyMessageText = z.string().max(1_000);
export const BudgetDollars = z.coerce.number().int().min(1).max(100_000); // console form field, × 100 → cents

export const TeamBudgetsInput = z.strictObject({
  defaultCents: z.number().int().min(50).nullable(),
  perAgent: z.partialRecord(z.enum(TEAM_AGENT_SLUGS), z.number().int().min(50)),
});
export type TeamBudgets = z.infer<typeof TeamBudgetsInput>;

// ---------- errors ----------
export type TeamErrorCode =
  | 'disabled'
  | 'invalid_input'
  | 'unknown_agent'
  | 'not_launchable'
  | 'portal_required'
  | 'portal_not_found'
  | 'portal_disabled'
  | 'portal_kind_not_allowed'
  | 'lockfile_missing'
  | 'lockfile_agent_missing'
  | 'environment_missing'
  | 'vault_not_configured'
  | 'kill_switch'
  | 'run_not_found'
  | 'run_not_active'
  | 'run_busy'
  | 'action_not_found'
  | 'action_already_decided'
  | 'permission_denied'
  | 'sod_denied'
  | 'budget_invalid';

export class TeamError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}

/** Anthropic session status → our run status (idle refinements come from events). */
export function mapSessionStatus(s: 'idle' | 'running' | 'rescheduling' | 'terminated'): RunStatus {
  return s === 'rescheduling' ? 'rescheduling' : s;
}
