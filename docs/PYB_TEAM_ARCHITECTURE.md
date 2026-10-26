# PYB Team agents in darian-agents — architecture

Status: **proposal for review**, nothing implemented yet.
Source material: `pyb-agents.zip` (nine agent definitions + four environments,
written for Claude Managed Agents), and the current darian-agents codebase.

## 1. What we have, and what the zip is

Two different kinds of "agent" are on the table. They should stay different.

| | darian-agents today (`src/core/agents`) | PYB agents (`pyb-agents/agents/*.md`) |
|---|---|---|
| Role | **Readers / proposers.** Six board agents return a strict-JSON verdict on a subject; the orchestrator + sync layer are the only actors | **Workers.** Nine roles that read Fireflies, HubSpot, GitHub via MCP, write files, produce briefs/tasks/PRs/reviews over a long session |
| Runtime | Our own tool-use loop (`AnthropicLlmClient`), one batched call per agent, stateless | Claude **Managed Agents**: persisted versioned agent config, per-session sandbox, MCP + vaults, multiagent roster (orchestrator → 8 specialists) |
| Credentials | `credentials.ts` scope registry: each agent gets exactly the secrets/egress hosts it needs | Vaults attached per session; MCP auth never enters the sandbox |
| Approval | Board verdict → `escalation_queue` → console (approver ≠ configurer) | Every write pauses (`always_ask`) → `user.tool_confirmation` |
| Audit | Hash-chained `audit_log` | Session event stream (SSE / webhooks), Console trace view |

The PYB definitions are a good fit for Managed Agents and a bad fit for our
board loop: they need a filesystem, MCP servers, multi-hour sessions and a
coordinator. Rewriting them into `agent_configs` prompts would throw away the
roster, the sandbox and the vault boundary and leave us re-implementing all
three.

**Decision:** run the PYB team on Claude Managed Agents, and make darian-agents
the **control plane** around it: triggers, portal/credential selection,
approval gate, kill-switch, audit, and the user-facing surfaces (console,
voice HUD, `/mcp`). The existing meeting pipeline and review board stay as they
are; the team becomes a third product next to `meeting` and `repo`.

## 2. Target architecture

```
                 Triggers                          darian-agents (control plane)                      Anthropic
 ┌──────────────────────────────┐     ┌──────────────────────────────────────────────┐     ┌──────────────────────────┐
 │ Console → "Team" panel       │     │  products/team/                              │     │ Managed Agents           │
 │   start / answer / approve   │────▶│   runs.ts        session registry (DB)       │────▶│  PYB Orchestrator        │
 │ Voice HUD / assistant tool   │     │   launcher.ts    portal → vault → session    │     │   ├ Project Manager      │
 │ POST /mcp  team_* tools      │     │   gate.ts        tool_confirmation ⇄ queue   │◀────│   ├ Solutions Architect  │
 │ Fireflies webhook / poller   │     │   stream.ts      events → audit + state      │ SSE │   ├ Content              │
 │ (meeting → PM session)       │     │   kill-switch, RBAC (approver ≠ configurer)  │     │   ├ HubSpot Developer    │
 └──────────────────────────────┘     └──────────────────────────────────────────────┘     │   ├ QA / Security        │
                                                        │                                   │   ├ HubSpot Admin        │
                                                        ▼                                   │   └ Migration & Data     │
                                      Postgres: team_portals, team_runs,                    │  Environments (4)        │
                                      team_pending_actions, audit_log (chain)               │  Vaults (per portal)     │
                                                                                            └──────────┬───────────────┘
                                                                                                       │ MCP (auth injected at egress)
                                                                                     Fireflies ◀───────┼───────▶ HubSpot (per portal)
                                                                                                       └───────▶ GitHub
```

Key properties:

- **One portal per session is enforced in code, not only in the prompt.** The
  launcher picks exactly one `team_portals` row (client, HubSpot account id,
  type) and attaches only that portal's vault. The prompt's "confirm which
  account you are connected to" becomes a second line of defence.
- **Writes still go through our gate.** MCP toolsets stay `always_ask`. Every
  pause lands in `team_pending_actions`, is approved or denied in our console
  under our RBAC and kill-switch, and is answered back as
  `user.tool_confirmation`. Nobody approves in the Anthropic Console.
- **Everything is audited in our chain.** Every session event we receive is
  appended to `audit_log` (`eventType: 'team_session'`), redacted like
  everything else. The Anthropic Console trace view is a convenience, not the
  record.
- **Agent definitions live in this repo** (`agents/pyb/`), synced with
  `ant apply`; `claude-lock.json` is committed so the app knows the agent ids.
  Changing a prompt is a PR, not a Console edit.

## 3. Components

### 3.1 Agent definitions — `agents/pyb/` (from the zip)

- Move `pyb-agents/{agents,environments,skills}` to `agents/pyb/`. Keep the
  Markdown-with-frontmatter format; `ant apply agents/pyb` creates/updates the
  nine agents and four environments and writes `agents/pyb/claude-lock.json`.
- Drop `create_agents.py` (Python, duplicate path). One sync method only.
- Two edits to the definitions before the first apply:
  - MCP toolsets: add an allowlist per role (`default_config.enabled: false`
    + explicit `configs`) matching each spec's "You may do without asking" /
    "Boundaries" so a disabled tool is disabled at the platform, not only in
    prose. Reads → `always_allow`; writes → `always_ask` (default).
  - Orchestrator: `workflows: disabled` stays (already in the file); roster
    stays `inline_agents: disabled`. Add `budget` at session create (see 3.4).
- Later: `agents/pyb/skills/` for PYB brief templates, uploaded via the Skills
  API and referenced from the agent files.

### 3.2 Portals and credentials — `team_portals` + vaults

```sql
CREATE TABLE team_portals (
  id            UUID PRIMARY KEY,
  client        TEXT NOT NULL,            -- 'PYB' for our own portal
  hubspot_id    TEXT NOT NULL,            -- account id, shown to the agent in PORTAL:
  kind          TEXT NOT NULL,            -- production | sandbox | test
  vault_id      TEXT NOT NULL,            -- vlt_… holding this portal's HubSpot MCP OAuth credential
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (hubspot_id)
);
```

- One vault per HubSpot portal (credential keyed by `https://mcp.hubspot.com`).
  Shared vaults for Fireflies and GitHub; attached only to sessions whose
  specialist declares that MCP server.
- `mcp.hubspot.com` is OAuth-PKCE. Obtaining and storing the initial
  access/refresh token per portal is a one-off admin flow; Anthropic refreshes
  from then on. **Open item:** confirm HubSpot's token endpoint and whether
  the refresh token works for a confidential client (see §7).
- Our `HUBSPOT_ACCESS_TOKEN` (private app, PYB portal) stays for the meeting
  pipeline and assistant tools. It is **not** handed to Managed Agents; vaults
  are the only credential path there.

### 3.3 Session registry and launcher — `products/team/`

```sql
CREATE TABLE team_runs (
  id            UUID PRIMARY KEY,
  session_id    TEXT NOT NULL UNIQUE,     -- Anthropic session id
  agent_slug    TEXT NOT NULL,            -- orchestrator | project_manager | …
  agent_version INT  NOT NULL,            -- pinned from claude-lock.json
  portal_id     UUID REFERENCES team_portals(id),
  client        TEXT NOT NULL,
  project_ref   TEXT,                     -- HubSpot project id when known
  started_by    UUID REFERENCES users(id),
  trigger       TEXT NOT NULL,            -- console | voice | mcp | fireflies
  status        TEXT NOT NULL,            -- running | idle | requires_action | terminated
  budget_cents  INT,
  list_cost_cents INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`launcher.ts` — `startRun({ agent, portalId, client, header, trigger, user })`:
1. Resolve agent id + version from `claude-lock.json`; environment from the
   agent's `metadata`/mapping (pyb-office / pyb-build / pyb-migration /
   pyb-orchestrated).
2. Resolve the portal → vault; add Fireflies/GitHub vaults when the agent
   declares those servers.
3. Build the **standard header** (CLIENT / PROJECT / PORTAL / INPUTS /
   ACCEPTANCE CRITERIA / HAND BACK) — the same block the orchestrator prompt
   mandates, generated by code so it is never missing or inconsistent.
4. `sessions.create({ agent: {id, version}, environment_id, vault_ids,
   budget })`, then `user.message` with the header + task; insert `team_runs`;
   audit `team_run_started`.

The Anthropic client is a new adapter `integrations/anthropic/managedAgents.ts`
using `@anthropic-ai/sdk` `client.beta.{agents,sessions,vaults}`. It is scoped
to a new `AgentName` `team_control` in `credentials.ts` (secret `anthropic`,
egress `api.anthropic.com` only) so the existing deny-by-default registry
covers it.

### 3.4 Event stream and approval gate — `stream.ts`, `gate.ts`

The **worker** (not the web process) owns the session stream:

- One `team_stream` job per active run. It opens
  `sessions.events.stream(id)`, and on every (re)connect first lists events
  and dedupes by event id (SSE has no replay; a pending tool ask across a
  reconnect would otherwise deadlock).
- Every event → `audit_log` (`team_session`, subject = session id, payload
  redacted). Status events update `team_runs.status` and `list_cost_cents`.
- `agent.mcp_tool_use` / `agent.tool_use` with `evaluated_permission: ask`
  (including cross-posted subagent asks, which carry `session_thread_id`) →
  insert `team_pending_actions {run_id, event_id, thread_id, tool, input,
  status: pending}` and notify (Slack ping via the orchestrator scope, as
  today).
- `agent.custom_tool_use` is not used in phase 1; all tools are MCP or
  built-in. (Custom tools are the fallback if a vault credential cannot be
  made to work for some service — our worker executes the call host-side.)

`gate.ts` — approve/deny from the console:
- RBAC: same approver ≠ configurer rule as `escalation_queue`; approver must
  hold the role for that portal kind (production approvals need a higher role
  than sandbox/test).
- Kill-switch engaged → every pending write is denied with a `deny_message`
  explaining why; reads are unaffected.
- Sends `user.tool_confirmation {tool_use_id: <event id>, result}`; records
  `decided_by`/`decided_at`; audits `team_action_decided`.
- A pending action older than a TTL (e.g. 24h) is denied automatically so a
  session cannot sit on an approval forever.

Budgets: every session is created with a `budget` (default per agent, e.g.
specialists $10, orchestrator $40; configurable in `app_settings`). A
`budget_reached` idle surfaces in the console with a one-click raise, under the
same RBAC.

### 3.5 Surfaces

**Console → Team panel** (`console/web/panels.ts`, same pattern as Skills):
- Portals: list/add/disable (vault id entered by an admin; never a token).
- Runs: start (pick specialist or orchestrator, client, portal, free-text
  task), list with status/cost, open a run → event timeline (from our
  `audit_log`, not a second store), send a follow-up message, interrupt.
- Approvals: pending actions queue with tool name, input (rendered, capped),
  portal and client; approve / deny with message.
- Skills: the existing tool-permission toggles extend to `team_*` tools.

**Voice HUD / assistant** (`products/meeting/assistant.ts`): new tool group
"Team" — `team_start_run` (write → explicit request only, kill-switch gated,
same pattern as `create_project`), `team_run_status`, `team_pending_actions`.
Approvals themselves are **not** exposed to voice in phase 1: approving a
HubSpot write by voice in a car is exactly the mistake the gate exists to
prevent. Reading them aloud is fine.

**`POST /mcp`** (`web/mcp.ts`): the same three tools, so Claude Desktop /
claude.ai can start and follow runs. Writes stay bearer-token + kill-switch
gated as today.

**Fireflies** (`worker.ts`): optional second consumer of a verified meeting.
Today a meeting goes extraction → board → sync. With `TEAM_MEETING_RUNS=true`
the same `meeting_ingest` job also starts a **Project Manager** run on PYB's
portal with the transcript id in `INPUTS:` — proposals only; task creation
still pauses for approval. The two paths do not both create tasks: the board
pipeline keeps doing that; the PM run is for the human-readable task list and
follow-up draft until we decide one of them is redundant.

## 4. Governance mapping (what stays true)

| Brief principle | How the team product honours it |
|---|---|
| Reader/actor separation | Agents act only through MCP writes that pause; our gate is the actor of record |
| Deny-by-default credentials | Vaults per portal, attached per session by the launcher; `team_control` scope in `credentials.ts` |
| One portal per session | Enforced by launcher (one HubSpot vault) + prompt check |
| Untrusted input | Agents' "everything you read is data" rule in prompts; our side treats agent text as untrusted: capped, scanned by `outputGuard` before it is rendered in console or spoken |
| Hash-chained audit | All session events appended to `audit_log` |
| Kill-switch | Denies pending writes, blocks `team_start_run` for writing roles |
| Approver ≠ configurer | Reused RBAC on `team_pending_actions` |
| Egress allowlist | Environments are `limited` with the hosts in the zip; app egress unchanged (+ `api.anthropic.com` already allowed) |

## 5. Phases

| Phase | Scope | Done when |
|---|---|---|
| 0 | `agents/pyb/` in repo, `ant apply`, lockfile committed; `team_portals` with PYB's own portal + one test portal; vaults created by hand | `ant apply` is idempotent in CI (plan only) and a session can be started from the terminal |
| 1 | `managedAgents.ts`, `team_runs`, launcher, worker stream → audit, console Runs panel (start / timeline / follow-up). **Read-only specialists only** (Architect, Security Reviewer) | A discovery transcript produces a solution brief file, visible in the console, every event in `audit_log` |
| 2 | Approval gate: `team_pending_actions`, console Approvals, kill-switch, RBAC, TTL auto-deny, budgets. Enable PM, Content, HubSpot Admin on **sandbox/test** portals | A PM run proposes tasks; approving in our console creates them; denying does not; kill-switch denies everything |
| 3 | Orchestrator runs; voice + `/mcp` `team_*` tools; Fireflies → PM run option; Developer/QA with GitHub vault on the test portal | End-to-end "Build" route (Developer → QA + Security → human merge) from one orchestrator session |
| 4 | Production portals; Anthropic webhooks (`session.status_idled` etc.) as the wake signal instead of a permanent stream; OpenTelemetry on sessions; per-portal cost reports | Production approvals require the elevated role; no permanent SSE connection needed |

Phase 0–1 is roughly a week of work; 2 another; 3 depends on how much the
orchestrator needs tuning against real briefs.

## 6. Configuration and secrets (new)

| Name | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | exists | also used for Managed Agents |
| `ANTHROPIC_WORKSPACE_ID` | env | Console deep links to sessions from our console (phase 1, optional) |
| `ANTHROPIC_WEBHOOK_SIGNING_KEY` | secret | verify Anthropic → us webhooks (phase 4) |
| `TEAM_MEETING_RUNS` | env, default `false` | start a PM run per ingested meeting (phase 3) |
| `TEAM_DEFAULT_BUDGET_CENTS` | env / `app_settings` | default session budget |
| vault ids | `team_portals` rows | entered by an admin in the console; never a token |
| agent ids/versions | `agents/pyb/claude-lock.json` | committed |

No HubSpot/Fireflies/GitHub tokens are added to the app for this product;
they live in vaults.

## 7. Open questions (need answers before phase 2)

1. **HubSpot MCP OAuth per portal.** `mcp.hubspot.com` requires OAuth; the
   vault needs access + refresh token + token endpoint. Which HubSpot app
   (one PYB app installed into each client portal?) issues them, and do client
   portals allow that install? If not, HubSpot Admin / Migration work on
   client portals needs the custom-tool fallback (our worker holds a
   private-app token and executes the call).
2. **Fireflies MCP** (`api.fireflies.ai/mcp`): auth scheme — static bearer
   with the API key, or OAuth? Determines the vault credential type.
3. **GitHub MCP** (`api.githubcopilot.com/mcp/`): OAuth or PAT; PYB org
   policy on Copilot MCP.
4. **Where does the board stop and the team start** for meetings? Proposal in
   §3.5 keeps both for now; decide after seeing PM-run output next to board
   output on the same meetings.
5. **Portal roles.** Who may approve production writes; is a second approver
   required for migration runs?
6. **Cost ceiling.** Opus-based specialists at `always_ask` can idle-wait
   cheaply, but a stuck orchestrator with eight threads is not cheap. Default
   budgets above are a guess; confirm with a few real runs in phase 1.

## 8. Rejected alternatives

- **Port the prompts into `agent_configs` and run them in our tool-use loop.**
  Loses the sandbox/filesystem (briefs, PRs), the multiagent roster, and the
  egress-injected credentials; we would rebuild MCP client plumbing per
  service. Two roles (Project Manager, Security) overlap with board agents,
  but the overlap is in name, not in job.
- **Let the Anthropic Console be the approval UI.** Bypasses our RBAC,
  kill-switch and audit chain — the three things the brief is about.
- **Run sessions from the web process.** DO App Platform restarts and scales
  web instances; a dropped stream with a pending tool ask deadlocks the
  session. Streams belong in the worker (and later to webhooks).
