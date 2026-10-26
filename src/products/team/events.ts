import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RawSessionEvent } from '../../integrations/anthropic/managedAgents.js';
import { canonicalize } from '../../core/audit/hashChain.js';
import { scanForInjection, sanitize } from '../../core/agents/sanitize.js';
import { log } from '../../core/obs/logger.js';
import { teamEventsProcessed } from '../../core/obs/metrics.js';
import type { PendingAction, ProcessResult, RunStatus, StreamDeps, TeamRun } from './types.js';

/**
 * Session events → state. Events are untrusted API envelopes (and carry
 * model-produced content): schemas are loose so new fields never break us, and
 * model `input` is kept as opaque capped data, never interpreted.
 */

export type TeamEvent =
  | { kind: 'status'; status: 'running' | 'rescheduling' | 'terminated' }
  | { kind: 'idle'; stopReason: string }
  | { kind: 'usage'; listCostCents: number | null }
  | { kind: 'budget'; budgetCents: number | null }
  | { kind: 'ask'; toolKind: 'mcp' | 'builtin'; toolName: string; mcpServer: string | null; input: unknown; threadId: string | null }
  | { kind: 'confirmation_echo'; toolUseId: string; result: 'allow' | 'deny' }
  | { kind: 'error'; message: string }
  | { kind: 'message'; text: string }
  | { kind: 'other' };

const MAX_ERROR_CHARS = 2_000;
const MAX_MESSAGE_CHARS = 20_000;
const INPUT_CAP_CHARS = 32_000;
const AUDIT_EVENT_CAP_CHARS = 16_000;
const INJECTION_SCAN_CHARS = 200_000;

const Amount = z.looseObject({ amount: z.union([z.string(), z.number()]) });
const centsOf = (v: unknown): number | null => {
  const parsed = Amount.safeParse(v);
  if (!parsed.success) return null;
  const n = Number(parsed.data.amount);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

const ToolUse = z.looseObject({
  name: z.string().min(1),
  evaluated_permission: z.string().optional(),
  mcp_server_name: z.string().nullish(),
  input: z.unknown().optional(),
});
const Idle = z.looseObject({ stop_reason: z.looseObject({ type: z.string() }).nullish() });
const Usage = z.looseObject({
  list_cost: z.unknown().optional(),
  usage: z.looseObject({ list_cost: z.unknown().optional() }).nullish(),
});
const Updated = z.looseObject({ budget: z.looseObject({ max_list_cost: z.unknown().optional() }).nullable() });
const Echo = z.looseObject({ tool_use_id: z.string().min(1), result: z.enum(['allow', 'deny']) });
const ErrorEvt = z.looseObject({
  message: z.string().optional(),
  error: z.union([z.string(), z.looseObject({ message: z.string().optional() })]).nullish(),
});
const MessageEvt = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});

export function threadIdOf(raw: RawSessionEvent): string | null {
  return typeof raw.session_thread_id === 'string' && raw.session_thread_id ? raw.session_thread_id : null;
}

export function parseTeamEvent(raw: RawSessionEvent): TeamEvent {
  switch (raw.type) {
    case 'session.status_running':
      return { kind: 'status', status: 'running' };
    case 'session.status_rescheduled':
      return { kind: 'status', status: 'rescheduling' };
    case 'session.status_terminated':
    case 'session.deleted': // gone for good: terminal, so pending asks are voided
      return { kind: 'status', status: 'terminated' };
    case 'session.status_idle': {
      const p = Idle.safeParse(raw);
      return { kind: 'idle', stopReason: p.success ? (p.data.stop_reason?.type ?? 'end_turn') : 'end_turn' };
    }
    case 'session.usage': {
      const p = Usage.safeParse(raw);
      return { kind: 'usage', listCostCents: p.success ? centsOf(p.data.list_cost ?? p.data.usage?.list_cost) : null };
    }
    case 'session.updated': {
      const p = Updated.safeParse(raw);
      if (!p.success) return { kind: 'other' };
      return { kind: 'budget', budgetCents: centsOf(p.data.budget?.max_list_cost) };
    }
    case 'agent.tool_use':
    case 'agent.mcp_tool_use': {
      const p = ToolUse.safeParse(raw);
      if (!p.success || p.data.evaluated_permission !== 'ask') return { kind: 'other' };
      const mcp = raw.type === 'agent.mcp_tool_use';
      return {
        kind: 'ask',
        toolKind: mcp ? 'mcp' : 'builtin',
        toolName: stripControlChars(p.data.name) as string,
        mcpServer: mcp ? ((stripControlChars(p.data.mcp_server_name ?? null) as string | null) ?? null) : null,
        input: p.data.input ?? null,
        threadId: threadIdOf(raw),
      };
    }
    case 'user.tool_confirmation': {
      const p = Echo.safeParse(raw);
      return p.success ? { kind: 'confirmation_echo', toolUseId: p.data.tool_use_id, result: p.data.result } : { kind: 'other' };
    }
    case 'session.error': {
      const p = ErrorEvt.safeParse(raw);
      let msg: string | undefined;
      if (p.success) {
        const e = p.data.error;
        msg = p.data.message ?? (typeof e === 'string' ? e : e?.message);
      }
      return { kind: 'error', message: (stripControlChars(msg ?? 'session error') as string).slice(0, MAX_ERROR_CHARS) };
    }
    case 'agent.message': {
      const p = MessageEvt.safeParse(raw);
      if (!p.success) return { kind: 'other' };
      const text = p.data.content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      return { kind: 'message', text: text.slice(0, MAX_MESSAGE_CHARS) };
    }
    default:
      return { kind: 'other' };
  }
}

/** Stable dedupe key: the API event id, or a content hash for id-less events (interrupts). */
export function eventKey(raw: RawSessionEvent): string {
  if (typeof raw.id === 'string' && raw.id.length > 0) return raw.id;
  return `anon:${createHash('sha256').update(canonicalize(raw)).digest('hex')}`;
}

// C0 controls except \t \n \r. Postgres JSONB (and TEXT) reject U+0000, and one
// such byte in a tool result would otherwise wedge the run's stream on replay.
// eslint-disable-next-line no-control-regex
const C0_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const MAX_SANITIZE_DEPTH = 64;

/** Recursively strip C0 control characters from every string and object key. */
export function stripControlChars(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(C0_CONTROLS, '');
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_SANITIZE_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.map((v) => stripControlChars(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k.replace(C0_CONTROLS, '')] = stripControlChars(v, depth + 1);
  return out;
}

/** Cap a value's serialised size. Over the cap it is replaced by a marked preview. */
export function capForAudit(value: unknown, maxChars = AUDIT_EVENT_CAP_CHARS): { value: unknown; truncated: boolean } {
  let json: string | undefined;
  try {
    // Honour toJSON first (Dates etc.), then sanitise the plain-data result.
    value = stripControlChars(JSON.parse(JSON.stringify(value) ?? 'null'));
    json = JSON.stringify(value);
  } catch {
    return { value: { unserializable: true }, truncated: true };
  }
  if (json === undefined || json.length <= maxChars) return { value, truncated: false };
  return { value: { truncated: true, originalChars: json.length, preview: json.slice(0, maxChars) }, truncated: true };
}

function idleStatus(stopReason: string): RunStatus {
  return stopReason === 'requires_action' || stopReason === 'budget_reached' ? stopReason : 'idle';
}

function safeJson(v: unknown): string {
  try {
    return (JSON.stringify(v) ?? '').slice(0, INJECTION_SCAN_CHARS);
  } catch {
    return '';
  }
}

/**
 * Apply one event, at-least-once: a crash between the audit append and the
 * seen-ledger write re-audits that event on the next list, never loses it.
 */
export async function processEvent(deps: StreamDeps, run: TeamRun, raw: RawSessionEvent): Promise<ProcessResult> {
  const type = String(raw.type).slice(0, 64);
  try {
    const result = await apply(deps, run, raw);
    teamEventsProcessed.inc({ type, outcome: result.duplicate ? 'duplicate' : 'processed' });
    return result;
  } catch (err) {
    teamEventsProcessed.inc({ type, outcome: 'error' });
    throw err;
  }
}

async function apply(deps: StreamDeps, run: TeamRun, raw: RawSessionEvent): Promise<ProcessResult> {
  const { store, audit } = deps;
  const key = eventKey(raw);
  const ev = parseTeamEvent(raw);
  const terminal = ev.kind === 'status' && ev.status === 'terminated';
  if (await store.hasSeenEvent(key)) return { duplicate: true, terminal };

  const now = deps.now();
  const threadId = threadIdOf(raw);

  switch (ev.kind) {
    case 'status':
      await store.updateRunState(run.id, { status: ev.status, stopReason: null });
      if (ev.status === 'terminated') await store.voidPendingForRun(run.id);
      break;
    case 'idle':
      await store.updateRunState(run.id, { status: idleStatus(ev.stopReason), stopReason: ev.stopReason });
      break;
    case 'usage':
      if (ev.listCostCents !== null) await store.updateRunState(run.id, { listCostCents: ev.listCostCents });
      break;
    case 'budget':
      if (ev.budgetCents !== null) await store.updateRunState(run.id, { budgetCents: ev.budgetCents });
      else log().warn({ runId: run.id }, 'team session budget removed outside the console');
      break;
    case 'ask': {
      const capped = capForAudit(ev.input, INPUT_CAP_CHARS);
      const { inserted, action } = await store.insertPendingAction({
        runId: run.id,
        eventId: raw.id,
        threadId: ev.threadId,
        toolKind: ev.toolKind,
        toolName: ev.toolName,
        mcpServer: ev.mcpServer,
        input: capped.value,
        inputTruncated: capped.truncated,
        injectionFlags: scanForInjection(safeJson(ev.input)).matches,
        portalId: run.portalId,
        portalKind: run.portalKind,
        expiresAt: new Date(now.getTime() + deps.cfg.approvalTtlHours * 3_600_000),
      });
      // A replay (crash between insert and announce) must still announce a pending
      // ask, or a frozen/disabled-portal ask would sit undecided. The pending audit
      // may repeat on that path; onNewAsk is idempotent.
      if (inserted || action.status === 'pending') await announceAsk(deps, run, action);
      break;
    }
    case 'confirmation_echo': {
      const settled = await store.settleFromEcho(ev.toolUseId, ev.result, now);
      if (settled && !settled.wasOurs) {
        log().warn({ runId: run.id, actionId: settled.action.id }, 'team tool ask answered outside the PYB console');
        await audit({
          eventType: 'team_action_decided',
          product: 'team',
          actorId: null,
          subjectId: run.id,
          payload: { actionId: settled.action.id, result: ev.result, reason: 'external' },
        });
      }
      break;
    }
    case 'error':
      await store.updateRunState(run.id, { lastError: ev.message });
      break;
    case 'message':
    case 'other':
      break;
  }

  // span.* events are trace detail (thousands per run): seen-ledger only.
  if (!raw.type.startsWith('span.')) {
    const capped = capForAudit(raw, AUDIT_EVENT_CAP_CHARS);
    const payload = {
      sessionId: run.sessionId,
      eventId: raw.id,
      eventType: raw.type,
      threadId,
      event: capped.value,
      truncated: capped.truncated,
    };
    try {
      await audit({ eventType: 'team_session', product: 'team', actorId: null, subjectId: run.id, payload });
    } catch (err) {
      // One unauditable event must not freeze the run: retry once with a minimal
      // payload; if even that fails the store is really down, so rethrow.
      const auditError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await audit({
        eventType: 'team_session',
        product: 'team',
        actorId: null,
        subjectId: run.id,
        payload: {
          sessionId: run.sessionId,
          eventId: raw.id,
          eventType: raw.type,
          threadId,
          truncated: true,
          auditError,
        },
      });
    }
  }

  await store.markEventSeen({ eventKey: key, runId: run.id, eventType: raw.type, threadId, processedAt: now });
  await store.updateRunState(run.id, { lastEventAt: now });
  return { duplicate: false, terminal };
}

async function announceAsk(deps: StreamDeps, run: TeamRun, action: PendingAction): Promise<void> {
  await deps.audit({
    eventType: 'team_action_pending',
    product: 'team',
    actorId: null,
    subjectId: run.id,
    payload: {
      actionId: action.id,
      eventId: action.eventId,
      toolKind: action.toolKind,
      toolName: action.toolName,
      mcpServer: action.mcpServer,
      portalKind: action.portalKind,
      injectionFlags: action.injectionFlags,
      expiresAt: action.expiresAt.toISOString(),
    },
  });
  if (deps.notify) {
    try {
      await deps.notify(
        `Team approval pending: ${sanitize(action.toolName, { maxLength: 64 })} on ${run.portalKind ?? 'no'} portal — /console/team/approvals`,
      );
    } catch (err) {
      log().warn({ err: String(err), runId: run.id }, 'team approval notification failed');
    }
  }
  await deps.gate.onNewAsk(action);
}
