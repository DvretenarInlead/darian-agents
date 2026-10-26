/**
 * Server-rendered views for the Team control plane. Everything here may contain
 * model-produced text (tool names, tool input, event payloads, task text), so
 * every dynamic value goes through `esc()` and nothing from an agent is ever
 * emitted as HTML.
 */
import { esc, csrfField } from './views.js';
import { scanForInjection } from '../../core/agents/sanitize.js';
import { TEAM_AGENT_CATALOG, TEAM_AGENT_SLUGS } from '../../products/team/catalog.js';
import {
  PORTAL_KINDS,
  type LockfileStatus,
  type PendingAction,
  type TeamBudgets,
  type TeamPortal,
  type TeamRun,
} from '../../products/team/types.js';

export const RENDER_CAP = 4_000;

/** Fixed, non-reflective notes shown after a redirect (the query value is only a lookup key). */
export const NOTES: Record<string, string> = {
  created: 'Portal added.',
  enabled: 'Portal enabled.',
  disabled: 'Portal disabled.',
  budgets: 'Budgets saved.',
  started: 'Run started.',
  sent: 'Message sent.',
  interrupted: 'Interrupt sent.',
  raised: 'Budget raised.',
  approved: 'Approved. The decision was sent to the agent.',
  denied: 'Denied. The decision was sent to the agent.',
  forced: 'Denied instead: external writes are frozen, the portal is disabled or the run has ended.',
  void: 'That run has already ended; the ask was voided.',
};

export function fmtDate(d: Date | null | undefined): string {
  return d ? d.toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '';
}

export function dollars(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '–' : `$${(cents / 100).toFixed(2)}`;
}

const PRE = 'style="white-space:pre-wrap;word-break:break-word;max-height:24rem;overflow:auto"';

/** Capped, escaped text in a <pre>, with an injection badge above it. */
function renderCapped(text: string, storedFlags: readonly string[] = []): string {
  const truncated = text.length > RENDER_CAP;
  return `${injectionBadge(text, storedFlags)}<pre ${PRE}>${esc(truncated ? text.slice(0, RENDER_CAP) : text)}</pre>${truncated ? '<div class="muted">truncated</div>' : ''}`;
}

/** Pretty JSON of untrusted data, capped, escaped, in a <pre>. */
export function renderJson(value: unknown, storedFlags: readonly string[] = []): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    text = '[unserialisable]';
  }
  return renderCapped(text, storedFlags);
}

/** Plain agent/operator text in a <pre>, capped and escaped. */
export function renderText(text: string): string {
  return renderCapped(text);
}

export function injectionBadge(text: string, storedFlags: readonly string[] = []): string {
  const scan = scanForInjection(text);
  const codes = [...new Set([...storedFlags, ...scan.matches])];
  if (codes.length === 0) return '';
  return `<span class="flash err">possible injected instructions: ${esc(codes.join(', '))}</span>`;
}

export function tabs(perms: { view: boolean; portals: boolean; approvals: boolean }): string {
  const link = (href: string, label: string) => `<a href="${href}">${label}</a>`;
  const items = [
    perms.view ? link('/console/team/runs', 'Runs') : '',
    perms.approvals ? link('/console/team/approvals', 'Approvals') : '',
    perms.portals ? link('/console/team/portals', 'Portals') : '',
  ].filter(Boolean);
  return `<p class="muted">${items.join(' · ')}</p>`;
}

export function notEnabledBody(): string {
  return '<h1>Team</h1><p class="muted">Team control plane is not enabled (TEAM_ENABLED, ANTHROPIC_API_KEY).</p>';
}

export function lockBanner(status: LockfileStatus | null): string {
  if (!status) return '<div class="flash err">Lockfile status unavailable.</div>';
  if (!status.ok) return `<div class="flash err">Agent lockfile unusable: ${esc(status.reason)}. Runs cannot start.</div>`;
  const warn = status.warnings.length ? `<div class="muted">${status.warnings.map(esc).join('<br>')}</div>` : '';
  return `<p class="muted">Lockfile OK: ${esc(Object.keys(status.agents).length)} agents, ${esc(Object.keys(status.environments).length)} environments.</p>${warn}`;
}

const launchableSlugs = () => TEAM_AGENT_SLUGS.filter((s) => TEAM_AGENT_CATALOG[s].launchable);

export function portalsPage(portals: TeamPortal[], budgets: TeamBudgets, maxBudgetCents: number, csrf: string): string {
  const rows = portals
    .map(
      (p) => `<tr><td>${esc(p.label)}</td><td>${esc(p.hubspotId)}</td><td>${esc(p.kind)}</td><td><code>${esc(p.vaultId)}</code></td><td>${p.enabled ? 'enabled' : '<strong>DISABLED</strong>'}</td>
      <td><form class="inline" method="post" action="/console/team/portals/${esc(p.id)}/toggle">${csrfField(csrf)}<input type="hidden" name="enabled" value="${p.enabled ? 'false' : 'true'}"><button${p.enabled ? ' class="danger"' : ''}>${p.enabled ? 'Disable' : 'Enable'}</button></form></td></tr>`,
    )
    .join('');
  const table = portals.length
    ? `<table><tr><th>Label</th><th>HubSpot id</th><th>Kind</th><th>Vault</th><th>State</th><th></th></tr>${rows}</table>`
    : '<p class="muted">No portals yet.</p>';
  const kindOptions = PORTAL_KINDS.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  const dollarsOf = (c: number | null | undefined) => (c === null || c === undefined ? '' : esc(c / 100));
  const agentFields = launchableSlugs()
    .map((s) => `<label>${esc(TEAM_AGENT_CATALOG[s].label)} <span class="muted">(dollars, empty = default)</span></label><input name="agent_${esc(s)}" inputmode="decimal" value="${dollarsOf(budgets.perAgent[s])}">`)
    .join('');
  return `<h1>Team portals</h1>${table}
    <div class="card"><strong>Add portal</strong>
      <form method="post" action="/console/team/portals">${csrfField(csrf)}
        <label>Label</label><input name="label" maxlength="120" required>
        <label>HubSpot portal id</label><input name="hubspotId" inputmode="numeric" pattern="\\d{1,20}" required>
        <label>Kind</label><select name="kind">${kindOptions}</select>
        <label>Anthropic vault id <span class="muted">(vlt_..., an id, never a token)</span></label><input name="vaultId" required>
        <p><button>Add portal</button></p>
      </form></div>
    <div class="card"><strong>Session budgets</strong>
      <p class="muted">Dollars per session; maximum ${esc(dollars(maxBudgetCents))}.</p>
      <form method="post" action="/console/team/budgets">${csrfField(csrf)}
        <label>Default <span class="muted">(empty = platform default)</span></label><input name="default" inputmode="decimal" value="${dollarsOf(budgets.defaultCents)}">
        ${agentFields}
        <p><button>Save budgets</button></p>
      </form></div>`;
}

export function runsPage(opts: {
  runs: TeamRun[];
  portals: TeamPortal[];
  lock: LockfileStatus | null;
  canRun: boolean;
  csrf: string;
}): string {
  const agentOptions = launchableSlugs().map((s) => `<option value="${esc(s)}">${esc(TEAM_AGENT_CATALOG[s].label)}</option>`).join('');
  const portalOptions =
    '<option value="">(none)</option>' +
    opts.portals
      .filter((p) => p.enabled)
      .map((p) => `<option value="${esc(p.id)}">${esc(p.label)} (${esc(p.kind)})</option>`)
      .join('');
  const form = opts.canRun
    ? `<div class="card" style="max-width:680px"><strong>Start a run</strong>
      <form method="post" action="/console/team/runs">${csrfField(opts.csrf)}
        <label>Specialist</label><select name="agentSlug">${agentOptions}</select>
        <label>Portal</label><select name="portalId">${portalOptions}</select>
        <label>Client label</label><input name="clientLabel" value="PYB" maxlength="120">
        <label>HubSpot project id <span class="muted">(optional, numeric)</span></label><input name="projectRef" inputmode="numeric">
        <label>Task</label><textarea name="task" required></textarea>
        <label>Inputs <span class="muted">(optional)</span></label><textarea name="inputs"></textarea>
        <label>Acceptance criteria <span class="muted">(optional)</span></label><textarea name="acceptanceCriteria"></textarea>
        <p><button>Start run</button></p>
      </form></div>`
    : '';
  const rows = opts.runs
    .map(
      (r) => `<tr><td><a href="/console/team/runs/${esc(r.id)}">${esc(TEAM_AGENT_CATALOG[r.agentSlug]?.label ?? r.agentSlug)}</a></td><td>${esc(r.portalKind ?? '–')}</td><td>${esc(r.status)}</td><td>${esc(r.stopReason ?? '')}</td><td>${esc(dollars(r.listCostCents))} / ${esc(dollars(r.budgetCents))}</td><td class="muted">${esc(fmtDate(r.createdAt))}</td></tr>`,
    )
    .join('');
  const table = opts.runs.length
    ? `<table><tr><th>Agent</th><th>Portal</th><th>Status</th><th>Stop reason</th><th>Cost / budget</th><th>Started</th></tr>${rows}</table>`
    : '<p class="muted">No runs yet.</p>';
  return `<h1>Team runs</h1>${lockBanner(opts.lock)}${form}${table}`;
}

export function approvalCard(a: PendingAction, csrf: string): string {
  const buttons =
    a.status === 'deciding'
      ? '<span class="muted">deciding…</span>'
      : a.status !== 'pending'
        ? `<span class="muted">${esc(a.status)}</span>`
        : `<form class="inline" method="post" action="/console/team/approvals/${esc(a.id)}/approve">${csrfField(csrf)}<button>Approve</button></form>
       <form method="post" action="/console/team/approvals/${esc(a.id)}/deny">${csrfField(csrf)}<label>Deny message <span class="muted">(optional, sent to the agent)</span></label><input name="denyMessage" maxlength="1000"><p><button class="danger">Deny</button></p></form>`;
  return `<div class="card" style="max-width:760px">
    <strong>${esc(a.toolName)}</strong> <span class="muted">${esc(a.toolKind)}${a.mcpServer ? ` · MCP ${esc(a.mcpServer)}` : ''}</span><br>
    <span class="muted">portal: ${esc(a.portalKind ?? 'none')} · <a href="/console/team/runs/${esc(a.runId)}">run</a> · asked ${esc(fmtDate(a.createdAt))} · expires ${esc(fmtDate(a.expiresAt))} · ${esc(a.status)}</span>
    ${renderJson(a.input, a.injectionFlags)}${a.inputTruncated ? '<div class="muted">input was truncated when stored</div>' : ''}
    ${buttons}</div>`;
}

export function approvalsPage(actions: PendingAction[], csrf: string): string {
  return `<h1>Team approvals</h1>${actions.length ? actions.map((a) => approvalCard(a, csrf)).join('') : '<p class="muted">No pending approvals.</p>'}`;
}

export interface TimelineRow {
  event_type: string;
  actor_id: string | null;
  payload: unknown;
  created_at: Date;
}

export function runPage(opts: {
  run: TeamRun;
  pending: PendingAction[];
  timeline: TimelineRow[];
  workspaceId: string | undefined;
  canRun: boolean;
  canBudget: boolean;
  csrf: string;
}): string {
  const { run } = opts;
  const link =
    opts.workspaceId && run.sessionId
      ? `<a href="https://platform.claude.com/workspaces/${esc(encodeURIComponent(opts.workspaceId))}/sessions/${esc(encodeURIComponent(run.sessionId))}" rel="noopener noreferrer">Open in Claude Console</a>`
      : '';
  const header = `<table>
    <tr><th>Agent</th><td>${esc(TEAM_AGENT_CATALOG[run.agentSlug]?.label ?? run.agentSlug)} <span class="muted">v${esc(run.agentVersion)}</span></td></tr>
    <tr><th>Status</th><td>${esc(run.status)}${run.stopReason ? ` <span class="muted">(${esc(run.stopReason)})</span>` : ''}</td></tr>
    <tr><th>Portal</th><td>${esc(run.portalKind ?? 'none')}</td></tr>
    <tr><th>Client</th><td>${esc(run.clientLabel)}${run.projectRef ? ` · project ${esc(run.projectRef)}` : ''}</td></tr>
    <tr><th>Cost / budget</th><td>${esc(dollars(run.listCostCents))} / ${esc(dollars(run.budgetCents))}</td></tr>
    <tr><th>Started</th><td>${esc(fmtDate(run.createdAt))} by ${esc(run.startedBy ?? 'system')} via ${esc(run.trigger)}</td></tr>
    <tr><th>Session</th><td>${esc(run.sessionId ?? '–')} ${link}</td></tr>
    ${run.lastError ? `<tr><th>Last error</th><td>${esc(run.lastError)}</td></tr>` : ''}
  </table>`;
  const active = run.status !== 'terminated' && run.status !== 'failed';
  const controls =
    opts.canRun && active && run.sessionId
      ? `<div class="card" style="max-width:680px"><strong>Follow up</strong>
        <form method="post" action="/console/team/runs/${esc(run.id)}/message">${csrfField(opts.csrf)}<label>Message</label><textarea name="text" required></textarea><p><button>Send</button></p></form>
        <form method="post" action="/console/team/runs/${esc(run.id)}/interrupt">${csrfField(opts.csrf)}<button class="danger">Interrupt</button></form></div>`
      : '';
  const raise =
    opts.canBudget && run.status === 'budget_reached'
      ? `<div class="card"><strong>Raise budget</strong>
        <form method="post" action="/console/team/runs/${esc(run.id)}/budget">${csrfField(opts.csrf)}<label>New budget (dollars)</label><input name="dollars" inputmode="numeric" required><p><button>Raise</button></p></form></div>`
      : '';
  const asks = opts.pending.length
    ? `<h2 style="font-size:1rem">Asks</h2>${opts.pending.map((a) => approvalCard(a, opts.csrf)).join('')}`
    : '';
  const timeline = opts.timeline.length
    ? `<table><tr><th>When</th><th>Event</th><th>Actor</th><th>Payload</th></tr>${opts.timeline
        .map((e) => `<tr><td class="muted">${esc(fmtDate(new Date(e.created_at)))}</td><td>${esc(e.event_type)}</td><td class="muted">${esc(e.actor_id ?? '')}</td><td>${renderJson(e.payload)}</td></tr>`)
        .join('')}</table>`
    : '<p class="muted">No events recorded yet.</p>';
  return `<h1>Team run</h1>${header}
    <h2 style="font-size:1rem">Task</h2>${renderText(run.task)}
    ${controls}${raise}${asks}
    <h2 style="font-size:1rem">Timeline</h2>${timeline}`;
}
