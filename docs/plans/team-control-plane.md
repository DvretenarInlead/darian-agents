# PYB Team control plane — phases 1 + 2

Source: `docs/PYB_TEAM_ARCHITECTURE.md` (§3.3–3.5, §5 phases 1–2), with these
owner decisions taking precedence where they differ:

- **Single tenant.** Only PYB's own HubSpot portal (`production`), plus at most a
  few `sandbox` / `test` portals. `team_portals` has no `client` column and there
  are no per-client portals or client-portal OAuth flow. The `CLIENT:` header line
  is a free-text label on the run (default `PYB`).
- **Scope:** launcher, session registry, worker stream → audit + pending asks,
  approval gate (RBAC, approver ≠ configurer, kill-switch, TTL auto-deny),
  budgets, and the console Team panel (Portals / Runs / Approvals). No
  orchestrator runs, no voice/MCP `team_*` tools, no Fireflies → PM trigger, no
  Anthropic webhooks.
- **Client:** official `@anthropic-ai/sdk` (`beta.sessions`, beta header set by
  the SDK), with its HTTP sent through a governed `fetch` that calls
  `assertEgressAllowed('team_control', host)` and resolves the key with
  `getScopedSecret('team_control', 'anthropic')`.

## 1. Goal

When this is done, a console user with `team:run` can start a Claude Managed
Agents session for one PYB Team specialist. The launcher resolves exactly one
`team_portals` row to its HubSpot vault, pins the agent id and version from
`agents/pyb/claude-lock.json`, writes the standard header, sets a dollar budget
and records the run in `team_runs`. A single leader in the worker fleet keeps
one SSE stream per active run. On every (re)connect it lists the event history
and dedupes by event id against a durable ledger. Every event lands in the
hash-chained `audit_log`. Every `evaluated_permission: "ask"` tool call becomes a
`team_pending_actions` row. These rows are approved or denied only in our
console, under RBAC, separation of duties (whoever started the run or configured
the portal cannot approve it) and the kill-switch. They are answered back as
`user.tool_confirmation`, and a row left undecided past the TTL is denied
automatically. Read-only specialists (Solutions Architect, Security Reviewer)
can run against any portal. Writing specialists (Project Manager, Content,
HubSpot Admin) can run only against sandbox/test portals. When the kill-switch
is on, every pending ask is denied and no writing-role run can start or resume.
Unit tests drive all of this against in-memory twins of the Managed Agents API
and the team store. Integration tests cover the SQL.

## 2. Modules

Six modules with disjoint file sets. Each module also owns any `*.test.ts` /
`*.itest.ts` file named in its entry. Files listed under §3 are written by the
orchestrator **before** fan-out, and no module edits them.

### M1 — Managed Agents SDK adapter

- **Owns:** `src/integrations/anthropic/managedAgentsSdk.ts`,
  `src/integrations/anthropic/governedFetch.ts`,
  `src/integrations/anthropic/managedAgentsSdk.test.ts`,
  `src/integrations/anthropic/governedFetch.test.ts`, `package.json`
  (dependency line only), `pnpm-lock.yaml`.
- **Responsibility:** implements the `ManagedAgentsClient` port (§3.3) on
  `@anthropic-ai/sdk` `client.beta.sessions.*`, sending all HTTP through the
  governed fetch.
- **Public surface:**
  - `createGovernedFetch(agent: AgentName, inner?: typeof fetch): typeof fetch`
  - `class SdkManagedAgentsClient implements ManagedAgentsClient` with
    `constructor(opts?: { fetchImpl?: typeof fetch; agent?: AgentName })`
    (defaults: global `fetch`, `'team_control'`).
- **Uses:** `assertEgressAllowed`, `getScopedSecret`, `EGRESS_HOSTS`
  (credentials.ts), and the port types from `managedAgents.ts`.
- **Details:**
  - `new Anthropic({ apiKey: GOVERNED_KEY_PLACEHOLDER, baseURL: 'https://api.anthropic.com', fetch: createGovernedFetch(agent, fetchImpl), maxRetries: 2 })`.
    - `GOVERNED_KEY_PLACEHOLDER = 'resolved-per-request'` is not a secret. The
      governed fetch overwrites `x-api-key` on every request, so the real key
      never sits on the SDK object.
    - `baseURL` is explicit so a stray `ANTHROPIC_BASE_URL` cannot redirect
      traffic. The egress assert would refuse it anyway.
  - The governed fetch:
    1. Parses the URL from `string | URL | Request`.
    2. Requires `protocol === 'https:'` and an empty `port`.
    3. Calls `assertEgressAllowed(agent, url.hostname)`.
    4. Clones the headers, `set('x-api-key', getScopedSecret(agent, 'anthropic'))`
       and `delete('authorization')`.
    5. Calls `inner`. It never logs headers.
    - It does **not** wrap `resilientFetch`: that adds a hard timeout which
      would kill long-lived SSE, and the SDK already retries 408/409/429/5xx.
  - Method mapping:
    - `createSession` → `client.beta.sessions.create({ agent: { type: 'agent', id, version }, environment_id, vault_ids, title, metadata, budget: { type: 'limit', max_list_cost: { amount: String(budgetCents), currency: 'USD' } } })`
    - `retrieveSession` → `client.beta.sessions.retrieve(id)`
    - `sendUserMessage` → `client.beta.sessions.events.send(id, { events: [{ type: 'user.message', content: [{ type: 'text', text }] }] })`
    - `sendToolConfirmation` → `events.send(id, { events: [{ type: 'user.tool_confirmation', tool_use_id, result, ...(result === 'deny' && denyMessage ? { deny_message: denyMessage } : {}) }] })`
    - `interrupt` → `events.send(id, { events: [{ type: 'user.interrupt' }] })`
    - `updateBudget` → `client.beta.sessions.update(id, { budget: { type: 'limit', max_list_cost: { amount: String(cents), currency: 'USD' } } })`
    - `listEvents` → `for await (const e of client.beta.sessions.events.list(id))`
    - `openEventStream` → `await client.beta.sessions.events.stream(id, {}, { signal, timeout: STREAM_TIMEOUT_MS })`
      with `STREAM_TIMEOUT_MS = 6 * 3600_000`. The supervisor reconnects when the
      stream ends.
  - Session objects map to `McSession`:
    - `usage?.list_cost?.amount` → `listCostCents` (parsed as an integer, `null` if absent).
    - `budget?.max_list_cost?.amount` → `budgetCents`.
  - Events pass through as `RawSessionEvent`: any object with string `id` and
    `type`. Anything else is dropped and logged at warn.
  - Pin an exact SDK version that exposes `client.beta.sessions.events.stream`
    and is at least two weeks old. Record it in the PR body.
- **Tests:** `governedFetch.test.ts`, `managedAgentsSdk.test.ts` (§6).

### M2 — Team store (Postgres)

- **Owns:** `src/products/team/store.ts`, `src/products/team/store.itest.ts`.
- **Responsibility:** `PgTeamStore implements TeamStore` (§3.2). All SQL for
  `team_portals`, `team_runs`, `team_run_events` and `team_pending_actions`
  lives here.
- **Public surface:** `class PgTeamStore implements TeamStore` with
  `constructor(pool: Pool, now?: () => Date)`.
- **Uses:** `pg` Pool and the types from `types.ts`.
- **Details:**
  - Every UPDATE sets `updated_at = now()`.
  - `claimDecision` is a single `UPDATE … SET status='deciding', decision=$2, decision_reason=$3, decided_by=$4, deny_message=$5, decided_at=now() WHERE id=$1 AND status='pending' RETURNING *`.
    It returns `null` when no row was updated.
  - `finalizeDecision` sets `status = CASE WHEN decision='allow' THEN 'approved' WHEN decision_reason='ttl' THEN 'expired' ELSE 'denied' END WHERE id=$1 AND status='deciding'`.
  - `settleFromEcho` does the same CASE for a `deciding` row. A `pending` row is
    set directly to approved/denied with `decision_reason='external'` and
    `decided_by=NULL`, `wasOurs=false`. Both in one transaction with
    `SELECT … FOR UPDATE`.
  - `markEventSeen` uses `INSERT … ON CONFLICT (event_key) DO NOTHING`.
  - `insertPendingAction` uses `INSERT … ON CONFLICT (event_id) DO NOTHING RETURNING *`.
    On conflict it re-selects and returns `inserted:false`.
  - `listStreamableRuns(idleCutoff)`:
    `status IN ('starting','running','requires_action','budget_reached','rescheduling') OR (status='idle' AND updated_at > $1)`,
    with `session_id IS NOT NULL`.
  - Row → type mapping: snake_case to camelCase, and `TIMESTAMPTZ` to `Date`.
- **Tests:** `store.itest.ts` (§6).

### M3 — Launcher, lockfile, header, budgets

- **Owns:** `src/products/team/launcher.ts`, `src/products/team/lockfile.ts`,
  `src/products/team/header.ts`, `src/products/team/budgets.ts`,
  `src/products/team/launcher.test.ts`, `src/products/team/lockfile.test.ts`,
  `src/products/team/header.test.ts`, `src/products/team/budgets.test.ts`,
  `agents/pyb/claude-lock.example.json` (fixture showing the assumed shape, with
  fake ids).
- **Responsibility:** the run lifecycle actions in `TeamLauncher` (start,
  follow-up, interrupt, raise budget), the tolerant `claude-lock.json` loader, the
  code-generated standard header, and budget resolution from config +
  `app_settings`.
- **Public surface:**
  - `createTeamLauncher(deps: LauncherDeps): TeamLauncher`
  - `loadLockfile(path: string, readFile?: (p: string) => Promise<string>): Promise<LockfileStatus>`
  - `normalizeSlug(raw: string): string`
  - `buildRunHeader(h: HeaderInput): string`
  - `loadTeamBudgets(pool: Pool): Promise<TeamBudgets>`
  - `resolveBudgetCents(b: TeamBudgets, slug: TeamAgentSlug, cfg: Config['team']): number`
  - `TEAM_BUDGETS_KEY = 'team_budgets'`
- **Uses:** the `ManagedAgentsClient` port, the `TeamStore` port,
  `TEAM_AGENT_CATALOG`, `AuditSink`, `SodPort`, `isWritesFrozen`, `sanitize()`
  and `config().team`.
- **Lockfile schema (lockfile.ts, tolerant):**

  ```ts
  const Version = z.union([z.number().int().positive(), z.string().regex(/^\d{1,9}$/).transform(Number)]);
  const LockAgent = z.looseObject({ id: z.string().min(1).max(128), version: Version });
  const LockEnv = z.looseObject({ id: z.string().min(1).max(128) });
  export const TeamLockfile = z.looseObject({
    agents: z.record(z.string(), z.unknown()).default({}),
    environments: z.record(z.string(), z.unknown()).default({}),
  });
  ```

  - Each `agents[k]` / `environments[k]` entry is parsed individually with
    `LockAgent` / `LockEnv`. A bad entry is skipped and reported in `warnings`,
    so one malformed entry never hides the rest.
  - Keys are normalised with `normalizeSlug`: lowercase, every run of
    non-alphanumerics becomes `_`, trim `_`, then strip a leading `pyb_`. So
    `PYB Project Manager`, `pyb-project-manager` and `project_manager` all
    resolve to `project_manager`, and `pyb-office` resolves to `office`.
  - Environment lookup uses `normalizeSlug(spec.environment)`.
  - A missing file, bad JSON or a missing top level returns
    `{ ok: false, reason }`. It never throws.
  - Cache by file mtime, checked at most every 30 s.
- **`startRun` order (each failure maps to a `TeamError` code):**
  1. `StartRunInput.parse` → `invalid_input`.
  2. `cfg.team.enabled` → `disabled`.
  3. Catalog entry exists and `launchable` → `unknown_agent` / `not_launchable`.
  4. If `spec.writes && await isWritesFrozen()` → `kill_switch`.
  5. Portal:
     - Required when `spec.mcp` includes `'hubspot'` (`portal_required`).
     - Must exist (`portal_not_found`) and be enabled (`portal_disabled`).
     - `kind` must be in `spec.allowedPortalKinds` (`portal_kind_not_allowed`).
     - When `spec.mcp` does not include hubspot, `portalId` must be null
       (`invalid_input`).
  6. Lockfile: agent → `lockfile_missing` / `lockfile_agent_missing`, then
     environment → `environment_missing`.
  7. `vaultIds`:
     - `portal.vaultId` when hubspot is declared.
     - `cfg.team.firefliesVaultId` when fireflies is declared **and set**;
       when unset the server is simply not attached (owner decision, Q7: the
       transcript can be pasted into `INPUTS:` / `TASK:` instead). The
       `team_run_started` audit payload lists `vaultsMissing: ['fireflies']`.
     - Same rule for github with `cfg.team.githubVaultId`.
     - `vault_not_configured` is therefore never thrown in phases 1–2; the
       code keeps the error code for a future strict mode.
  8. Budget: `resolveBudgetCents`.
  9. `store.insertRun({... status 'starting'})`, then
     `sod.record({ subjectId: sodSubject.run(run.id), action: 'configured', actorId: startedBy })`.
  10. `client.createSession({ agentId, agentVersion, environmentId, vaultIds, budgetCents, title: \`PYB ${slug} ${run.id.slice(0, 8)}\`, metadata: { team_run_id: run.id, portal_kind: portal?.kind ?? 'none' } })`.
      - On throw: `store.markRunFailed(run.id, msg)`, audit `team_run_failed`,
        rethrow.
  11. `store.attachSession(run.id, session.id, mapSessionStatus(session.status))`.
  12. `client.sendUserMessage(session.id, buildRunHeader(...))`.
      - On throw: `updateRunState(run.id, { status: 'idle', lastError })`, audit
        `team_run_failed` with `{ stage: 'kickoff' }`, rethrow. The session
        exists, so an operator can retry with a follow-up.
  13. Audit `team_run_started`, then return `store.getRun(run.id)`.
- **`followUp`:**
  - Run must exist, have a session, and status not in
    `terminated | failed | requires_action | budget_reached` → `run_not_active`
    / `run_busy`.
  - If `spec.writes && frozen` → `kill_switch`.
  - Send `sanitize(text, { maxLength: 20_000 })`.
  - `updateRunState({ status: 'running' })` so the supervisor reopens the stream.
  - `sod.record(configured, run subject)`, audit `team_run_message`.
- **`interrupt`:** always allowed, even with the kill-switch on. Requires a
  session and status ≠ `terminated`. Audit `team_run_interrupted`.
- **`raiseBudget`:**
  - `newCents` integer.
  - Must be `> (run.listCostCents ?? 0)` and `> run.budgetCents`, and
    `<= cfg.team.maxBudgetCents` → `budget_invalid`.
  - If `spec.writes && frozen` → `kill_switch`.
  - `client.updateBudget`, `updateRunState({ budgetCents })`, audit
    `team_budget_changed` with `{ fromCents, toCents }`.
- **Header (`buildRunHeader`):** exactly these lines.

  ```
  CLIENT: <clientLabel>
  PROJECT: <projectRef ?? 'none'>
  PORTAL: <portal ? `${hubspotId} (${kind}) — confirm you are connected to this account before any action` : 'none'>
  INPUTS: <inputs || 'none'>
  ACCEPTANCE CRITERIA: <acceptanceCriteria || spec.defaultAcceptance>
  HAND BACK: <spec.handBack>
  ---
  TASK:
  <task>
  ```

  - Single-line fields: `sanitize(..., { maxLength: 200 })` with `\r\n`
    replaced by spaces.
  - Multi-line fields: `sanitize` with the §3.1 caps.
- **Budgets setting (`app_settings` key `team_budgets`):**
  - Value: `TeamBudgets = { defaultCents: number | null; perAgent: Partial<Record<TeamAgentSlug, number>> }`.
  - zod: integers in 50..`cfg.team.maxBudgetCents`. Malformed or missing →
    `{ defaultCents: null, perAgent: {} }`.
  - `resolveBudgetCents` precedence: `perAgent[slug]`, then `defaultCents`,
    then `spec.defaultBudgetCents ?? cfg.team.defaultBudgetCents`.
- **Tests:** §6.

### M4 — Event processor, stream supervisor, worker wiring

- **Owns:** `src/products/team/events.ts`, `src/products/team/stream.ts`,
  `src/products/team/supervisor.ts`, `src/products/team/events.test.ts`,
  `src/products/team/stream.test.ts`, `src/products/team/supervisor.test.ts`,
  **`src/worker.ts`** (registration lines), `src/core/obs/metrics.ts`
  (two team metrics).
- **Responsibility:**
  - Parse raw session events.
  - Apply each event idempotently: run state, the pending-ask ledger, the audit
    record, notify, and the gate hook.
  - Run the leader-elected supervisor that keeps one stream per streamable run,
    with list + dedupe on every (re)connect, and periodic housekeeping.
- **Public surface:**
  - `parseTeamEvent(raw: RawSessionEvent): TeamEvent`
  - `eventKey(raw: RawSessionEvent): string`
  - `capForAudit(value: unknown, maxChars?: number): { value: unknown; truncated: boolean }`
  - `processEvent(deps: StreamDeps, run: TeamRun, raw: RawSessionEvent): Promise<ProcessResult>`
  - `createTeamSupervisor(deps: SupervisorDeps): TeamSupervisor`
- **Uses:** the `ManagedAgentsClient` port, the `TeamStore` port, the
  `TeamGate` port, `AuditSink`, `scanForInjection()`, `sanitize()`, `log()` and
  `withCronLock` (worker only).
- **Event model (events.ts).** zod schemas are `looseObject`: these are API
  envelopes and must tolerate new fields. Model-produced `input` is kept as
  opaque data and never interpreted.

  ```ts
  export type TeamEvent =
    | { kind: 'status'; status: 'running' | 'rescheduling' | 'terminated' }
    | { kind: 'idle'; stopReason: string }                    // session.status_idle (stop_reason.type)
    | { kind: 'usage'; listCostCents: number | null }        // session.usage
    | { kind: 'budget'; budgetCents: number | null }         // session.updated carrying `budget`
    | { kind: 'ask'; toolKind: 'mcp' | 'builtin'; toolName: string; mcpServer: string | null; input: unknown; threadId: string | null } // agent.(mcp_)tool_use with evaluated_permission==='ask'
    | { kind: 'confirmation_echo'; toolUseId: string; result: 'allow' | 'deny' } // user.tool_confirmation
    | { kind: 'error'; message: string }                     // session.error (message capped 2000)
    | { kind: 'message'; text: string }                      // agent.message text blocks joined, capped 20_000
    | { kind: 'other' };
  ```

  - Type mapping: `session.status_running` → `running`,
    `session.status_rescheduled` → `rescheduling`,
    `session.status_terminated` → `terminated`.
  - `eventKey`: `raw.id` when non-empty. Otherwise
    `anon:` + sha256 of the canonical JSON (interrupt events can have empty ids).
- **`processEvent(deps, run, raw)`.** At-least-once. A crash between steps 3
  and 4 re-audits one event, never loses one.
  1. `key = eventKey(raw)`. If `await store.hasSeenEvent(key)`, return
     `{ duplicate: true, terminal: isTerminal }`. No side effects.
  2. Side effects by kind. All of them are idempotent.
     - `status` → `updateRunState({ status, stopReason: null })`.
       `terminated` also calls `store.voidPendingForRun(run.id)`.
     - `idle` → status `requires_action` | `budget_reached` | `idle` from
       `stopReason`. Other values (`end_turn`, `retries_exhausted`) → `idle`.
       Store `stopReason`.
     - `usage` → `listCostCents`.
     - `budget` → `budgetCents` when non-null. Null means it was removed
       outside our console: log warn and audit as-is.
     - `ask` →
       - `capForAudit(input, 32_000)`.
       - `injectionFlags = scanForInjection(JSON.stringify(input)).matches`.
       - `store.insertPendingAction({ ..., portalId: run.portalId, portalKind: run.portalKind, expiresAt: now + cfg.team.approvalTtlHours })`.
       - If `inserted`: audit `team_action_pending`; `notify?.(\`Team approval pending: ${sanitize(toolName,{maxLength:64})} on ${run.portalKind ?? 'no'} portal — /console/team/approvals\`)`
         (best-effort, catch and log); then `await gate.onNewAsk(action)`.
     - `confirmation_echo` → `store.settleFromEcho(toolUseId, result, now)`.
       When `wasOurs === false`, audit `team_action_decided` with
       `{ reason: 'external' }` and log warn: someone answered outside our
       console.
     - `error` → `updateRunState({ lastError: message })`.
  3. Audit `team_session` — **except for events whose `type` starts with
     `span.`** (owner decision, Q9: they are trace detail and would add
     thousands of chained rows per run; they still go to the seen-ledger in
     step 4):
     - `subjectId = run.id`.
     - Payload `{ sessionId, eventId: raw.id, eventType: raw.type, threadId, event: capForAudit(raw, 16_000).value, truncated }`.
  4. `store.markEventSeen({ eventKey: key, runId, eventType, threadId, processedAt })`
     and `updateRunState({ lastEventAt: now })`.
  5. Return `{ duplicate: false, terminal }`. `terminal` is true for
     `terminated`.
- **Stream scheduling: decision and justification.** The decision is a
  long-running supervisor loop in the worker under `withCronLock` (leader
  election). It is not one durable job per run. Reasons:
  - `runConsumer` (`src/core/queue/consumer.ts`) is single-flight: a worker runs
    one job at a time. A stream job that holds an SSE connection for minutes or
    hours would block `meeting_ingest` and `repo_score` on that worker. With N
    active runs, N workers would be pinned.
  - Making the per-run job short (poll, then re-enqueue) turns streaming into
    polling. It would write one `jobs` row per run every few seconds into a table
    that has no cleanup. `jobs_dedupe_key_idx` is unique across all statuses, so
    every generation would also need a fresh dedupe key, which removes the
    "one job per run" guarantee the key was supposed to give.
  - Durability does not come from the job queue here. It comes from
    `team_run_events` (durable seen-ledger) plus list-on-connect. Any process
    that becomes leader rebuilds every stream from history without double
    effects. A crashed leader's session-level advisory lock is released when its
    connection drops, and another worker takes over on its next 5 s attempt.
  - This matches the existing Fireflies poller pattern in `worker.ts`, keeps
    streams out of the web tier (architecture doc §8) and is single tenant
    (a handful of concurrent runs). Phase 4's webhooks replace the permanent
    stream without changing `processEvent`.
- **Supervisor (`supervisor.ts`):**
  `createTeamSupervisor(deps).run(stopped)` returns when `stopped()` is true and
  closes all streams with `AbortController.abort()`.
  - **Every `tickMs` (default 5_000):**
    1. `runs = store.listStreamableRuns(now - cfg.team.streamIdleCloseMin)`.
    2. For each run id not in `connections`, start `connect(run)`.
    3. Abort connections whose run is no longer listed.
    4. `if (await isWritesFrozen()) await gate.enforceKillSwitch()`.
  - **Every `housekeepingMs` (default 60_000):**
    - `gate.expireStale()`, `gate.reconcileStuck()`.
    - For each listed run, `client.retrieveSession(sessionId)`. If it reports
      `terminated` and the DB disagrees, `updateRunState({ status: 'terminated' })`
      and `voidPendingForRun` (catches a missed terminal event). Also refresh
      `listCostCents`.
  - **`connect(run)`:** one serial loop per run.
    1. `stream = await client.openEventStream(sessionId, signal)`. Open first:
       stream-first ordering.
    2. `for await (e of client.listEvents(sessionId)) await processEvent(...)`.
    3. `for await (e of stream) { r = await processEvent(...); if (r.terminal) break; }`.
       Already-seen events are skipped inside `processEvent`, and the terminal
       check runs even for duplicates.
    4. When the stream ends or throws and the run is still listed, reconnect
       with backoff `min(60_000, 2_000 * 2^attempt)` plus jitter. The attempt
       resets after a successful connect.
    5. A `processEvent` throw (DB down) is logged. The connection is torn down
       and reconnected, so the event is retried via list.
- **Metrics (`metrics.ts` additions):**
  - `teamEventsProcessed`: Counter `team_events_processed_total`, labels
    `['type','outcome']` (outcome `processed | duplicate | error`).
  - `teamStreamsOpen`: Gauge `team_streams_open`.
- **`src/worker.ts` registration.** M4 adds exactly this block after the
  Fireflies poller block, plus the imports:

  ```ts
  // PYB Team control plane: one leader holds the Managed Agents session streams
  // (advisory lock; failover when its connection drops). See
  // docs/plans/team-control-plane.md for why this is a loop, not a job per run.
  const teamDone = (async () => {
    if (!cfg.team.enabled || !cfg.anthropic.apiKey) return;
    const client = new SdkManagedAgentsClient();
    const store = new PgTeamStore(pool);
    const isWritesFrozen = () => isEngaged(pool);
    const audit = pgAuditSink(pool, () => new Date());
    const gate = createTeamGate({ store, client, audit, isWritesFrozen, sod: pgSodPort(pool), now: () => new Date() });
    const supervisor = createTeamSupervisor({
      store, client, gate, audit, isWritesFrozen, now: () => new Date(), cfg: cfg.team,
      ...(notifier ? { notify: (t: string) => notifier.notify(t) } : {}),
    });
    log().info('team supervisor candidate');
    while (!stopping) {
      try {
        await withCronLock(pool, 'team_stream_supervisor', () => supervisor.run(stopped));
      } catch (err) {
        log().error({ err: String(err) }, 'team supervisor crashed; retrying');
      }
      for (let waited = 0; waited < 5_000 && !stopping; waited += 1_000) await sleep(1_000);
    }
  })();
  ```

  - Add `await teamDone;` next to `await pollerDone;`.
  - The leader holds one pool connection for the lock for its whole tenure.
    That is acceptable with `DATABASE_POOL_MAX=10`.
- **Tests:** §6.

### M5 — Approval gate

- **Owns:** `src/products/team/gate.ts`, `src/products/team/gate.test.ts`.
- **Responsibility:** every decision on a pending ask:
  - human approve/deny, with RBAC by portal kind, SoD, kill-switch, portal
    disabled and run terminated;
  - TTL expiry;
  - kill-switch sweep;
  - immediate deny on arrival when frozen or the portal is disabled;
  - recovery of stuck `deciding` rows.
- **Public surface:** `createTeamGate(deps: GateDeps): TeamGate`.
- **Uses:** the `TeamStore` port, the `ManagedAgentsClient` port, `AuditSink`,
  `SodPort`, `isWritesFrozen`, `sanitize()`, `TEAM_PERMS` and `sodSubject`.
- **`decide({ actionId, actor, result, denyMessage })`:**
  1. `action = store.getPendingAction(id)` → `action_not_found`.
     `status !== 'pending'` → `action_already_decided`.
  2. `run = store.getRun(action.runId)`. If `run.status === 'terminated'`:
     `store.voidPendingForRun(run.id)`, return `{ status: 'void', reason: 'approver', forced: true }`.
  3. Permission: `action.portalKind === 'production'` ? `team:approve_production`
     : `team:approve`. Use `hasTeamPerm(actor, perm)` → `permission_denied`.
     The check applies to both allow and deny, so only approvers settle asks.
  4. Only for `result === 'allow'` **and only when `action.portalKind === 'production'`**:
     `sod.assertApprovalAllowed(actor.id, sodSubject.run(run.id))`, and when
     `action.portalId` is set, `sod.assertApprovalAllowed(actor.id, sodSubject.portal(action.portalId))`.
     A `SeparationOfDutiesError` becomes `sod_denied`. Denying your own run's
     ask is always allowed (safe direction). **Owner decision (Q3):** on
     `sandbox` / `test` portals and portal-less asks the run starter may
     approve, so a single operator can run UAT; the audit payload records
     `selfApproved: true` in that case.
  5. Forcing, only for allow:
     - `await isWritesFrozen()` → result `deny`, reason `kill_switch`,
       `denyMessage = DENY_MESSAGES.kill_switch`.
     - Otherwise, if the portal is disabled → `deny`, `portal_disabled`.
     - `forced = true` in both cases.
  6. `claimed = store.claimDecision(id, { decision, reason, decidedBy: actor.id, denyMessage: sanitized })`.
     `null` → `action_already_decided` (lost a race).
  7. `client.sendToolConfirmation(run.sessionId, { toolUseId: action.eventId, result, denyMessage })`.
     - On throw: `store.revertDecision(id, msg)`, audit `team_action_decided`
       with `{ outcome: 'send_failed' }`, rethrow.
  8. `store.finalizeDecision(id)`.
     `sod.record({ subjectId: sodSubject.action(id), action: result === 'allow' ? 'approved' : 'rejected', actorId })`.
     Audit `team_action_decided` with `{ actionId, eventId, toolName, result, reason, forced, portalKind }`,
     `subjectId = run.id`.
  9. Return the `GateOutcome`.
  - Human deny messages: `sanitize(msg, { maxLength: 1000 })`, defaulting to
    `DENY_MESSAGES.approver`.
- **System decisions:** `decideAsSystem(action, reason)` is internal. It does
  steps 6–8 with `decidedBy: null` and `result: 'deny'`, using the
  `DENY_MESSAGES[reason]` text, and skips the SoD record.
  - `onNewAsk(action)`: if frozen → `kill_switch`; else if the portal is
    disabled → `portal_disabled`; else no-op.
  - `expireStale()`: `store.listExpired(now, 100)`, each with reason `ttl`.
    Returns the count.
  - `enforceKillSwitch()`: `listPendingActions(['pending'], 500)`, each with
    `kill_switch`. Returns the count.
  - `reconcileStuck()`: `listStuckDeciding(now - 5 min, 100)` →
    `revertDecision(id, 'confirmation not echoed within 5 minutes')`. Log warn
    and return the count. A real send would have been echoed and settled by the
    stream.
- **Tests:** §6.

### M6 — Console Team panel and web wiring

- **Owns:** `src/console/web/teamPanels.ts`, `src/console/web/teamViews.ts`,
  `src/console/web/teamPanels.test.ts`, `src/console/web/plugin.ts`
  (one registration line), `src/console/web/context.ts` (`team?` on
  `ConsoleDeps`), `src/console/web/views.ts` (one NAV entry),
  `src/console/web/panels.ts` (only: add `export` to `guard` and `needsSudo`,
  and skip `team_control` in the Agents roster), **`src/index.ts`** (team
  wiring), `scripts/check-env.ts` (one feature line), `.do/app.yaml` (new env
  vars).
- **Responsibility:** server-rendered Team pages over the `TeamLauncher`,
  `TeamGate` and `TeamStore` ports, plus constructing those in the web process.
- **Public surface:** `registerTeamRoutes(app: FastifyInstance, deps: ConsoleDeps): void`.
- **Uses:** `guard`, `needsSudo`, `csrfOk`, `ensureCsrf`, `csrfField`, `esc`,
  `layout`, `appendAudit` (portal/budget config), `recordSodAction`,
  `scanForInjection` and the team ports.
- **Edits outside the new files:**
  - `context.ts`: `export interface TeamConsoleDeps { store: TeamStore; launcher: TeamLauncher; gate: TeamGate; lockStatus: () => Promise<LockfileStatus>; }`
    and `team?: TeamConsoleDeps` on `ConsoleDeps`.
  - `plugin.ts`: `registerTeamRoutes(app, deps);` after `registerPanelRoutes`.
  - `views.ts` NAV: `{ href: '/console/team/runs', label: 'Team', perm: 'team:view' }`
    after Escalations.
  - `panels.ts`: `export async function guard`, `export function needsSudo`,
    and `AGENTS.filter((a) => a !== 'team_control')` in the Agents page.
    `team_control` is a control-plane identity with no prompt.
- **Routes.** Every route is `guard(req, reply, deps, perm)`. When `deps.team`
  is absent, a page renders "Team control plane is not enabled (TEAM_ENABLED,
  ANTHROPIC_API_KEY)". Every POST does `csrfOk` → 403, then `needsSudo` where
  marked. Ids in `:id` are validated as UUID (`z.uuid()`) before any query →
  404. A `TeamError` maps to a flash message (`invalid_input`, `kill_switch`, …),
  never a stack trace.

  | Method + path | Perm | Sudo | Does |
  |---|---|---|---|
  | GET `/console/team` | team:view | – | redirect `/console/team/runs` |
  | GET `/console/team/portals` | team:portals | – | list portals (label, hubspot id, kind, vault id, enabled); add form; budgets card (`team_budgets`) |
  | POST `/console/team/portals` | team:portals | yes | `PortalInput.parse` → `store.createPortal` → `recordSodAction(configured, sodSubject.portal(id))` → `appendAudit(config_change, product 'team', subject sodSubject.portal(id), {action:'create', kind, hubspotId, vaultId})` |
  | POST `/console/team/portals/:id/toggle` | team:portals | yes | `setPortalEnabled` + SoD configured + `config_change` audit |
  | POST `/console/team/budgets` | team:portals | yes | `TeamBudgetsInput.parse` → upsert `app_settings` key `team_budgets` (same SQL shape as Skills) → SoD configured `team_budgets` → `config_change` audit |
  | GET `/console/team/runs` | team:view | – | lockfile status banner; start form (if `team:run`; agent select shows only `launchable` catalog entries, portal select only enabled portals); last 100 runs (agent, portal kind, status, stop reason, cost/budget, started) |
  | POST `/console/team/runs` | team:run | yes | `launcher.start({... trigger:'console', startedBy: user.id})` → redirect to run page |
  | GET `/console/team/runs/:id` | team:view | – | run header fields, task, Console deep link when `cfg.team.workspaceId` is set (`https://platform.claude.com/workspaces/${workspaceId}/sessions/${sessionId}`), pending asks for the run, timeline = `SELECT event_type, actor_id, payload, created_at FROM audit_log WHERE subject_id=$1 AND product='team' ORDER BY id LIMIT 500`; follow-up form, interrupt button, raise-budget form when `budget_reached` |
  | POST `/console/team/runs/:id/message` | team:run | – | `launcher.followUp` |
  | POST `/console/team/runs/:id/interrupt` | team:run | – | `launcher.interrupt` |
  | POST `/console/team/runs/:id/budget` | team:budget | yes | `launcher.raiseBudget({ newCents: dollars*100 })` |
  | GET `/console/team/approvals` | team:approve **or** team:approve_production | – | `listPendingActions(['pending','deciding'], 200)` with tool, mcp server, portal kind, run link, age/expiry, injection-flag badge, input preview |
  | POST `/console/team/approvals/:id/approve` | (checked in gate) team:approve* | yes | `gate.decide({result:'allow'})` |
  | POST `/console/team/approvals/:id/deny` | (checked in gate) team:approve* | yes | `gate.decide({result:'deny', denyMessage})` |

- **Rendering untrusted content (`teamViews.ts`):**
  - Agent text, tool names, tool input and event payloads all go through
    `esc()`.
  - Inputs and payloads use `JSON.stringify(v, null, 2)` capped at 4_000 chars
    with a "truncated" note, inside `<pre>`.
  - Text with `scanForInjection(...).suspicious` gets
    `<span class="flash err">possible injected instructions: …</span>` above it.
  - No raw HTML from the agent is ever rendered.
- **`src/index.ts` wiring.** Before `createConsole`:

  ```ts
  const team = cfg.team.enabled && cfg.anthropic.apiKey ? buildTeamConsoleDeps(getPool()) : undefined;
  ```

  - `buildTeamConsoleDeps` is a local function in index.ts. It constructs
    `SdkManagedAgentsClient`, `PgTeamStore`,
    `createTeamGate({... isWritesFrozen: () => isEngaged(pool), sod: pgSodPort(pool) })`,
    `createTeamLauncher({...})` and `lockStatus: () => loadLockfile(cfg.team.lockfilePath)`.
  - Pass `...(team ? { team } : {})` into `createConsole`.
  - The web process sends confirmations and kickoff messages itself. It never
    opens streams.
- **`scripts/check-env.ts`:** add
  `['Team control plane (TEAM_ENABLED + ANTHROPIC_API_KEY)', cfg.team.enabled && Boolean(cfg.anthropic.apiKey)]`.
- **`.do/app.yaml`:** add `TEAM_ENABLED` (`"false"`), `TEAM_APPROVAL_TTL_HOURS`,
  `TEAM_DEFAULT_BUDGET_CENTS`, `TEAM_MAX_BUDGET_CENTS` and the two vault-id vars
  (plain values, not secrets) to `app_envs`.
- **Tests:** `teamPanels.test.ts` (§6).

## 3. Shared contracts (written by the orchestrator before fan-out)

Files in this section are complete specifications. Modules import them and never
edit them.

### 3.0 Edits to existing files

**`src/core/agents/contract.ts`.** Append to `AGENTS`, after `'assistant'`:

```ts
  'team_control', // PYB Team control plane — drives Managed Agents sessions; not a board voter, no prompt
```

**`src/core/governance/credentials.ts`.** Add to `AGENT_SCOPES`:

```ts
  // Team control plane: only the Managed Agents REST surface. HubSpot/Fireflies/
  // GitHub credentials for team sessions live in Anthropic vaults, never here.
  team_control: ANTHROPIC,
```

**`src/core/audit/writer.ts`.** Extend the unions. The `audit_log.event_type` and
`product` columns are TEXT with no CHECK, so no migration is needed:

```ts
export type AuditEventType =
  | 'ingest' | 'verdict' | 'autofix' | 'escalation' | 'approval' | 'external_write' | 'config_change' | 'auth_event'
  | 'team_run_started'     // launcher: session created + kickoff sent
  | 'team_run_failed'      // launcher: create or kickoff failed ({ stage: 'create' | 'kickoff', error })
  | 'team_run_message'     // follow-up user.message sent
  | 'team_run_interrupted' // user.interrupt sent
  | 'team_budget_changed'  // session budget raised
  | 'team_session'         // every session event received (redacted, capped)
  | 'team_action_pending'  // new pending ask recorded
  | 'team_action_decided'; // approve/deny/ttl/kill_switch/portal_disabled/external/send_failed

export type AuditProduct = 'meeting' | 'repo' | 'console' | 'team';
```

For every `team_*` event, `subjectId` is the `team_runs.id` UUID, so the run
timeline is one indexed query on `audit_log_subject_idx`. Portal and budget
changes use the existing `config_change` type with product `'team'` and subject
`team_portal:<uuid>` / `team_budgets`.

**`src/config/index.ts`.** Add to `envSchema`:

```ts
  /** PYB Team control plane (Managed Agents). Off by default; needs ANTHROPIC_API_KEY. */
  TEAM_ENABLED: boolish.default(false),
  TEAM_LOCKFILE_PATH: z.string().default('agents/pyb/claude-lock.json'),
  /** Default session budget (cents) when neither app_settings nor the catalog sets one. */
  TEAM_DEFAULT_BUDGET_CENTS: z.coerce.number().int().min(50).default(1000),
  /** Hard ceiling for any budget set or raised from the console (cents). */
  TEAM_MAX_BUDGET_CENTS: z.coerce.number().int().min(50).default(10000),
  /** Pending approvals older than this are denied automatically. */
  TEAM_APPROVAL_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Idle (end_turn) runs keep their stream open this long, then close until a follow-up. */
  TEAM_STREAM_IDLE_CLOSE_MIN: z.coerce.number().int().min(1).default(30),
  /** Shared vault ids (vlt_…) — ids, not secrets. Unset → agents that declare the server cannot launch. */
  TEAM_FIREFLIES_VAULT_ID: z.string().regex(/^vlt_[A-Za-z0-9_-]{1,128}$/).optional(),
  TEAM_GITHUB_VAULT_ID: z.string().regex(/^vlt_[A-Za-z0-9_-]{1,128}$/).optional(),
  /** Anthropic workspace id for Console deep links to sessions (optional). */
  ANTHROPIC_WORKSPACE_ID: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
```

Add to `Config`:

```ts
  team: {
    enabled: boolean;
    lockfilePath: string;
    defaultBudgetCents: number;
    maxBudgetCents: number;
    approvalTtlHours: number;
    streamIdleCloseMin: number;
    firefliesVaultId: string | undefined;
    githubVaultId: string | undefined;
    workspaceId: string | undefined;
  };
```

Add to `build()`:
`team: { enabled: raw.TEAM_ENABLED, lockfilePath: raw.TEAM_LOCKFILE_PATH, defaultBudgetCents: raw.TEAM_DEFAULT_BUDGET_CENTS, maxBudgetCents: raw.TEAM_MAX_BUDGET_CENTS, approvalTtlHours: raw.TEAM_APPROVAL_TTL_HOURS, streamIdleCloseMin: raw.TEAM_STREAM_IDLE_CLOSE_MIN, firefliesVaultId: raw.TEAM_FIREFLIES_VAULT_ID, githubVaultId: raw.TEAM_GITHUB_VAULT_ID, workspaceId: raw.ANTHROPIC_WORKSPACE_ID },`

**`.env.example`.** Add the same nine variables, commented, with the defaults
above.

### 3.1 `src/products/team/types.ts`

```ts
import { z } from 'zod';
import type { Pool } from 'pg';
import { appendAudit, type AuditEvent } from '../../core/audit/writer.js';
import { assertApprovalAllowed, recordSodAction, type SodEntry } from '../../console/rbac/sod.js';
import type { Config } from '../../config/index.js';
import { TEAM_AGENT_SLUGS, type TeamAgentSlug } from './catalog.js';

// ---------- enums ----------
export const PORTAL_KINDS = ['production', 'sandbox', 'test'] as const;
export type PortalKind = (typeof PORTAL_KINDS)[number];

export const RUN_STATUSES = ['starting', 'running', 'idle', 'requires_action', 'budget_reached', 'rescheduling', 'terminated', 'failed'] as const;
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
  approve: 'team:approve',                       // sandbox/test (and portal-less) asks
  approveProduction: 'team:approve_production', // asks on the production portal
  portals: 'team:portals',                       // portals + team_budgets settings
  budget: 'team:budget',                         // raise a session budget
} as const;

export interface TeamActor { id: string; permissions: string[] }
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
  eventId: string;           // the agent.(mcp_)tool_use event id == tool_use_id for the confirmation
  threadId: string | null;   // session_thread_id for cross-posted subagent asks
  toolKind: 'mcp' | 'builtin';
  toolName: string;
  mcpServer: string | null;
  input: unknown;            // model-produced; data only, capped
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

  insertRun(input: NewRun): Promise<TeamRun>;                          // status 'starting', session_id NULL
  attachSession(runId: string, sessionId: string, status: RunStatus): Promise<void>;
  markRunFailed(runId: string, error: string): Promise<void>;          // status 'failed', last_error (capped 2000)
  getRun(id: string): Promise<TeamRun | null>;
  listRuns(limit: number): Promise<TeamRun[]>;                         // newest first
  listStreamableRuns(idleCutoff: Date): Promise<TeamRun[]>;
  updateRunState(runId: string, patch: RunStatePatch): Promise<void>;

  hasSeenEvent(eventKey: string): Promise<boolean>;
  markEventSeen(entry: SeenEvent): Promise<void>;                     // idempotent

  insertPendingAction(input: NewPendingAction): Promise<{ inserted: boolean; action: PendingAction }>;
  getPendingAction(id: string): Promise<PendingAction | null>;
  listPendingActions(statuses: readonly PendingStatus[], limit: number): Promise<PendingAction[]>; // oldest first
  listPendingForRun(runId: string): Promise<PendingAction[]>;
  claimDecision(id: string, claim: DecisionClaim): Promise<PendingAction | null>; // pending → deciding, atomic
  finalizeDecision(id: string): Promise<void>;                        // deciding → approved | denied | expired
  revertDecision(id: string, error: string): Promise<void>;           // deciding → pending, clears decision, sets last_error
  settleFromEcho(toolUseId: string, result: ToolDecision, at: Date): Promise<{ action: PendingAction; wasOurs: boolean } | null>;
  listExpired(now: Date, limit: number): Promise<PendingAction[]>;    // status 'pending' AND expires_at <= now
  listStuckDeciding(olderThan: Date, limit: number): Promise<PendingAction[]>; // status 'deciding' AND updated_at < olderThan
  voidPendingForRun(runId: string): Promise<number>;                  // pending|deciding → void
}

export type AuditSink = (event: AuditEvent) => Promise<void>;
export function pgAuditSink(pool: Pool, now: () => Date): AuditSink {
  return async (event) => { await appendAudit(pool, event, now().toISOString()); };
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

export interface LockResolution { agentId: string; agentVersion: number; environmentId: string }
export type LockfileStatus =
  | { ok: true; agents: Record<string, { id: string; version: number }>; environments: Record<string, { id: string }>; warnings: string[] }
  | { ok: false; reason: string };

// ---------- module deps ----------
export interface LauncherDeps {
  pool: Pool;                                   // only for loadTeamBudgets
  store: TeamStore;
  client: import('../../integrations/anthropic/managedAgents.js').ManagedAgentsClient;
  audit: AuditSink;
  sod: SodPort;
  isWritesFrozen: () => Promise<boolean>;
  lockStatus: () => Promise<LockfileStatus>;
  cfg: Config['team'];
  now: () => Date;
}

export interface GateDeps {
  store: TeamStore;
  client: import('../../integrations/anthropic/managedAgents.js').ManagedAgentsClient;
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
  client: import('../../integrations/anthropic/managedAgents.js').ManagedAgentsClient;
  isWritesFrozen: () => Promise<boolean>;
  tickMs?: number;          // default 5_000
  housekeepingMs?: number;  // default 60_000
  sleep?: (ms: number) => Promise<void>;
}

export interface TeamSupervisor { run(stopped: () => boolean): Promise<void> }

export interface ProcessResult { duplicate: boolean; terminal: boolean }

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
  | 'disabled' | 'invalid_input' | 'unknown_agent' | 'not_launchable'
  | 'portal_required' | 'portal_not_found' | 'portal_disabled' | 'portal_kind_not_allowed'
  | 'lockfile_missing' | 'lockfile_agent_missing' | 'environment_missing' | 'vault_not_configured'
  | 'kill_switch' | 'run_not_found' | 'run_not_active' | 'run_busy'
  | 'action_not_found' | 'action_already_decided' | 'permission_denied' | 'sod_denied' | 'budget_invalid';

export class TeamError extends Error {
  constructor(readonly code: TeamErrorCode, message: string) {
    super(message);
    this.name = 'TeamError';
  }
}

/** Anthropic session status → our run status (idle refinements come from events). */
export function mapSessionStatus(s: 'idle' | 'running' | 'rescheduling' | 'terminated'): RunStatus {
  return s === 'rescheduling' ? 'rescheduling' : s;
}
```

The `TeamBudgetsInput` maximum (`cfg.team.maxBudgetCents`) is checked at use
sites (M3 `resolveBudgetCents`, M6 budgets POST), because the zod schema is
static.

### 3.2 `src/products/team/catalog.ts`

The slugs and environment mapping are **assumptions** (see §7 Q1). The lockfile
loader normalises names onto these slugs.

```ts
import type { PortalKind } from './types.js';

export const TEAM_AGENT_SLUGS = [
  'orchestrator', 'project_manager', 'solutions_architect', 'content',
  'hubspot_developer', 'qa', 'security_reviewer', 'hubspot_admin', 'migration_data',
] as const;
export type TeamAgentSlug = (typeof TEAM_AGENT_SLUGS)[number];

export const TEAM_ENVIRONMENTS = ['pyb-office', 'pyb-build', 'pyb-migration', 'pyb-orchestrated'] as const;
export type TeamEnvironment = (typeof TEAM_ENVIRONMENTS)[number];

export type TeamMcpServer = 'hubspot' | 'fireflies' | 'github';

export interface TeamAgentSpec {
  slug: TeamAgentSlug;
  label: string;
  environment: TeamEnvironment;
  /** Role may propose HubSpot/GitHub writes (gated by always_ask either way). Drives kill-switch + portal-kind policy. */
  writes: boolean;
  mcp: readonly TeamMcpServer[];
  allowedPortalKinds: readonly PortalKind[];
  /** Phase gate: only launchable roles appear in the console start form. */
  launchable: boolean;
  defaultBudgetCents: number | null; // null → cfg.team.defaultBudgetCents
  handBack: string;
  defaultAcceptance: string;
}

const ALL: readonly PortalKind[] = ['production', 'sandbox', 'test'];
const NON_PROD: readonly PortalKind[] = ['sandbox', 'test'];

export const TEAM_AGENT_CATALOG: Record<TeamAgentSlug, TeamAgentSpec> = {
  orchestrator:        { slug: 'orchestrator', label: 'PYB Orchestrator', environment: 'pyb-orchestrated', writes: true, mcp: ['hubspot', 'fireflies', 'github'], allowedPortalKinds: NON_PROD, launchable: false, defaultBudgetCents: 4000, handBack: 'Summary of every specialist hand-back and what still needs a human.', defaultAcceptance: 'Every specialist task closed or explicitly handed back.' },
  project_manager:     { slug: 'project_manager', label: 'Project Manager', environment: 'pyb-office', writes: true, mcp: ['hubspot', 'fireflies'], allowedPortalKinds: NON_PROD, launchable: true, defaultBudgetCents: null, handBack: 'Proposed task list and follow-up draft; every HubSpot write waits for PYB approval.', defaultAcceptance: 'Each task has an owner, a due date and a source quote.' },
  solutions_architect: { slug: 'solutions_architect', label: 'Solutions Architect', environment: 'pyb-office', writes: false, mcp: ['hubspot', 'fireflies'], allowedPortalKinds: ALL, launchable: true, defaultBudgetCents: null, handBack: 'Solution brief written to /mnt/session/outputs/ and summarised in your final message.', defaultAcceptance: 'Brief covers scope, objects/properties, integrations, risks and open questions.' },
  content:             { slug: 'content', label: 'Content', environment: 'pyb-office', writes: true, mcp: ['hubspot'], allowedPortalKinds: NON_PROD, launchable: true, defaultBudgetCents: null, handBack: 'Drafts and the exact HubSpot changes proposed; writes wait for approval.', defaultAcceptance: 'Drafts match the brief and PYB tone.' },
  hubspot_developer:   { slug: 'hubspot_developer', label: 'HubSpot Developer', environment: 'pyb-build', writes: true, mcp: ['hubspot', 'github'], allowedPortalKinds: NON_PROD, launchable: false, defaultBudgetCents: null, handBack: 'PR link and test evidence.', defaultAcceptance: 'Tests pass; PR description lists every portal change.' },
  qa:                  { slug: 'qa', label: 'QA', environment: 'pyb-build', writes: false, mcp: ['hubspot', 'github'], allowedPortalKinds: NON_PROD, launchable: false, defaultBudgetCents: null, handBack: 'QA report with pass/fail per acceptance criterion.', defaultAcceptance: 'Every criterion tested.' },
  security_reviewer:   { slug: 'security_reviewer', label: 'Security Reviewer', environment: 'pyb-build', writes: false, mcp: ['hubspot'], allowedPortalKinds: ALL, launchable: true, defaultBudgetCents: null, handBack: 'Findings with severity, evidence and fix; no changes made.', defaultAcceptance: 'Each finding has a reproducible failure path.' },
  hubspot_admin:       { slug: 'hubspot_admin', label: 'HubSpot Admin', environment: 'pyb-office', writes: true, mcp: ['hubspot'], allowedPortalKinds: NON_PROD, launchable: true, defaultBudgetCents: null, handBack: 'List of portal changes made (after approval) and anything left undone.', defaultAcceptance: 'Every change approved in the PYB console before it was made.' },
  migration_data:      { slug: 'migration_data', label: 'Migration & Data', environment: 'pyb-migration', writes: true, mcp: ['hubspot'], allowedPortalKinds: NON_PROD, launchable: false, defaultBudgetCents: null, handBack: 'Migration report with row counts and rejects.', defaultAcceptance: 'Counts reconcile.' },
};
```

### 3.3 `src/integrations/anthropic/managedAgents.ts` (port + in-memory twin)

```ts
/**
 * Claude Managed Agents behind a port. The team control plane (launcher, gate,
 * supervisor) depends only on this interface; the SDK adapter lives in
 * managedAgentsSdk.ts and routes HTTP through the governance layer. Events are
 * passed through raw (id + type + whatever the API sends); parsing is the
 * consumer's job (products/team/events.ts) so new event fields never break I/O.
 */

export type McSessionStatus = 'idle' | 'running' | 'rescheduling' | 'terminated';

export interface McSession {
  id: string;
  status: McSessionStatus;
  listCostCents: number | null;
  budgetCents: number | null;
}

export interface McCreateSessionInput {
  agentId: string;
  agentVersion: number;
  environmentId: string;
  vaultIds: string[];
  budgetCents: number;
  title: string;
  metadata: Record<string, string>;
}

export interface McToolConfirmation {
  toolUseId: string;          // the agent.(mcp_)tool_use EVENT id, not a toolu_ id
  result: 'allow' | 'deny';
  denyMessage: string | null; // sent only with 'deny'
}

/** A received session event: always has string id + type; everything else is opaque. */
export interface RawSessionEvent {
  id: string;
  type: string;
  processed_at?: string | null;
  session_thread_id?: string | null;
  [key: string]: unknown;
}

export interface ManagedAgentsClient {
  createSession(input: McCreateSessionInput): Promise<McSession>;
  retrieveSession(sessionId: string): Promise<McSession>;
  sendUserMessage(sessionId: string, text: string): Promise<void>;
  sendToolConfirmation(sessionId: string, c: McToolConfirmation): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  updateBudget(sessionId: string, cents: number): Promise<McSession>;
  /** Full history, oldest first (auto-paginated). */
  listEvents(sessionId: string): AsyncIterable<RawSessionEvent>;
  /** Resolves once the SSE connection is open (stream-first ordering); iterates live events until closed/aborted. */
  openEventStream(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<RawSessionEvent>>;
}

export type OutboundEvent =
  | { type: 'user.message'; text: string }
  | { type: 'user.tool_confirmation'; toolUseId: string; result: 'allow' | 'deny'; denyMessage: string | null }
  | { type: 'user.interrupt' };

type Push = (e: RawSessionEvent | null) => void;

/** Deterministic in-memory twin for tests. No network, no timers. */
export class InMemoryManagedAgents implements ManagedAgentsClient {
  readonly creates: McCreateSessionInput[] = [];
  readonly sent: Array<{ sessionId: string; event: OutboundEvent }> = [];
  readonly budgetUpdates: Array<{ sessionId: string; cents: number }> = [];
  private readonly sessions = new Map<string, McSession>();
  private readonly history = new Map<string, RawSessionEvent[]>();
  private readonly subscribers = new Map<string, Set<Push>>();
  private readonly failures = new Map<keyof ManagedAgentsClient, Error>();
  private seq = 0;

  /** Make the next call to `method` throw `err` once. */
  failNext(method: keyof ManagedAgentsClient, err: Error): void { this.failures.set(method, err); }

  /** Simulate the server emitting an event. historyOnly = emitted during a stream gap. */
  emit(sessionId: string, event: RawSessionEvent, opts: { historyOnly?: boolean } = {}): void {
    this.historyOf(sessionId).push(event);
    if (!opts.historyOnly) for (const push of this.subscribers.get(sessionId) ?? []) push(event);
  }

  /** Simulate a dropped SSE connection: every open iterator for the session ends. */
  dropStreams(sessionId: string): void {
    for (const push of this.subscribers.get(sessionId) ?? []) push(null);
  }

  setSession(sessionId: string, patch: Partial<McSession>): void {
    const s = this.mustGet(sessionId);
    this.sessions.set(sessionId, { ...s, ...patch });
  }

  openStreamCount(sessionId: string): number { return this.subscribers.get(sessionId)?.size ?? 0; }

  async createSession(input: McCreateSessionInput): Promise<McSession> {
    this.maybeFail('createSession');
    this.creates.push(input);
    const s: McSession = { id: `sesn_mem_${++this.seq}`, status: 'idle', listCostCents: 0, budgetCents: input.budgetCents };
    this.sessions.set(s.id, s);
    return s;
  }
  async retrieveSession(sessionId: string): Promise<McSession> { this.maybeFail('retrieveSession'); return this.mustGet(sessionId); }
  async sendUserMessage(sessionId: string, text: string): Promise<void> {
    this.maybeFail('sendUserMessage'); this.mustGet(sessionId);
    this.sent.push({ sessionId, event: { type: 'user.message', text } });
  }
  async sendToolConfirmation(sessionId: string, c: McToolConfirmation): Promise<void> {
    this.maybeFail('sendToolConfirmation'); this.mustGet(sessionId);
    this.sent.push({ sessionId, event: { type: 'user.tool_confirmation', toolUseId: c.toolUseId, result: c.result, denyMessage: c.denyMessage } });
  }
  async interrupt(sessionId: string): Promise<void> {
    this.maybeFail('interrupt'); this.mustGet(sessionId);
    this.sent.push({ sessionId, event: { type: 'user.interrupt' } });
  }
  async updateBudget(sessionId: string, cents: number): Promise<McSession> {
    this.maybeFail('updateBudget');
    this.budgetUpdates.push({ sessionId, cents });
    this.setSession(sessionId, { budgetCents: cents });
    return this.mustGet(sessionId);
  }
  async *listEvents(sessionId: string): AsyncIterable<RawSessionEvent> {
    this.maybeFail('listEvents');
    for (const e of [...this.historyOf(sessionId)]) yield e;
  }
  async openEventStream(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<RawSessionEvent>> {
    this.maybeFail('openEventStream'); this.mustGet(sessionId);
    const queue: Array<RawSessionEvent | null> = [];
    let wake: (() => void) | null = null;
    const push: Push = (e) => { queue.push(e); wake?.(); };
    const subs = this.subscribers.get(sessionId) ?? new Set<Push>();
    subs.add(push); this.subscribers.set(sessionId, subs); // registered eagerly = stream-first
    const onAbort = () => push(null);
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { subs.delete(push); signal.removeEventListener('abort', onAbort); };
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            if (queue.length === 0) await new Promise<void>((r) => { wake = r; });
            wake = null;
            const e = queue.shift();
            if (e === null || e === undefined) return;
            yield e;
          }
        } finally { cleanup(); }
      },
    };
  }

  private maybeFail(method: keyof ManagedAgentsClient): void {
    const err = this.failures.get(method);
    if (err) { this.failures.delete(method); throw err; }
  }
  private mustGet(id: string): McSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  }
  private historyOf(id: string): RawSessionEvent[] {
    let h = this.history.get(id);
    if (!h) { h = []; this.history.set(id, h); }
    return h;
  }
}
```

### 3.4 `src/products/team/memoryStore.ts` (in-memory `TeamStore` twin)

This file is test-only infrastructure. It mirrors the SQL semantics that M2
implements and that `store.itest.ts` proves, and it enforces the same unique
constraints. Required behaviour:

- `class InMemoryTeamStore implements TeamStore` with
  `constructor(now: () => Date = () => new Date())`. Public read-only maps
  `portals`, `runs`, `seen`, `actions` (all `Map<string, …>`) for assertions.
- Ids come from `randomUUID()` (`node:crypto`).
- `createPortal`:
  - Throws `Error('duplicate hubspot_id')` when the hubspotId already exists.
  - Throws `Error('production portal exists')` when a second `production` row
    is inserted (the partial unique index).
- `insertRun`: `status: 'starting'`, `sessionId: null`, `stopReason: null`,
  `listCostCents: null`, `lastError: null`, `lastEventAt: null`.
- `attachSession`:
  - Throws on a duplicate sessionId.
  - Sets `sessionId` and `status`.
- `markRunFailed`: `status: 'failed'`, `lastError: error.slice(0, 2000)`.
- `listRuns`: sorted by `createdAt` descending.
- `listStreamableRuns`: same predicate as M2.
- `updateRunState`: applies only the keys present in the patch.
- `hasSeenEvent` / `markEventSeen`: a set keyed by `eventKey`. The first insert
  wins.
- `insertPendingAction`:
  - Unique on `eventId`. Returns `{ inserted: false, action: existing }` on a
    duplicate.
  - New rows start `status: 'pending'` with every decision field `null`,
    `lastError: null`.
- `listPendingActions`: filter by status, sort by `createdAt` ascending, take
  `limit`.
- `claimDecision`: only when `status === 'pending'`. Sets `status: 'deciding'`,
  the decision fields and `decidedAt = now()`, and returns the row. Otherwise
  returns `null`.
- `finalizeDecision`: only from `deciding`. `allow` → `approved`; `ttl` →
  `expired`; otherwise `denied`.
- `revertDecision`: only from `deciding`. Sets `status: 'pending'`, clears the
  decision fields and sets `lastError`.
- `settleFromEcho`, matched by `eventId === toolUseId`:
  - `deciding` → finalize, return `wasOurs: true`.
  - `pending` → set the final status from `result`,
    `decisionReason: 'external'`, `decidedBy: null`, `decidedAt: at`, return
    `wasOurs: false`.
  - Anything else → `null`.
- `listExpired`: `pending` rows with `expiresAt <= now`.
- `listStuckDeciding`: `deciding` rows with `updatedAt < olderThan`.
- `voidPendingForRun`: `pending|deciding` → `void`. Returns the count.
- Every mutation sets `updatedAt = now()`.

### 3.5 Migration `migrations/0006_team_control.sql`

```sql
-- ============================================================================
-- Migration 0006 — PYB Team control plane (Managed Agents), phases 1–2
--
-- Single tenant: PYB's own HubSpot portal (production) plus sandbox/test
-- portals. Credentials for those portals live in Anthropic vaults; this schema
-- stores only vault ids. team_run_events is the durable seen-ledger that makes
-- stream reconnects (list + dedupe by event id) idempotent across restarts and
-- leader failover. team_pending_actions is the approval queue the console gate
-- decides; nothing is approved in the Anthropic Console.
-- ============================================================================

CREATE TABLE team_portals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label       TEXT NOT NULL,                       -- 'PYB production', 'PYB sandbox'
  hubspot_id  TEXT NOT NULL,                       -- HubSpot account id (numeric), shown to the agent in PORTAL:
  kind        TEXT NOT NULL,                       -- production | sandbox | test
  vault_id    TEXT NOT NULL,                       -- vlt_… holding this portal's HubSpot MCP credential
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID REFERENCES users(id),
  updated_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_portals_hubspot_id_key UNIQUE (hubspot_id),
  CONSTRAINT team_portals_kind_chk CHECK (kind IN ('production', 'sandbox', 'test')),
  CONSTRAINT team_portals_hubspot_id_chk CHECK (hubspot_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT team_portals_vault_id_chk CHECK (vault_id ~ '^vlt_[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT team_portals_label_chk CHECK (char_length(label) BETWEEN 1 AND 120)
);
-- Single tenant: at most one production portal, ever (enabled or not).
CREATE UNIQUE INDEX team_portals_one_production_idx ON team_portals (kind) WHERE kind = 'production';

CREATE TABLE team_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT UNIQUE,                     -- Anthropic session id; NULL until sessions.create succeeds
  agent_slug      TEXT NOT NULL,                   -- catalog slug (products/team/catalog.ts)
  agent_id        TEXT NOT NULL,                   -- pinned from claude-lock.json
  agent_version   INT  NOT NULL,
  environment_id  TEXT NOT NULL,
  portal_id       UUID REFERENCES team_portals(id),
  portal_kind     TEXT,                            -- snapshot at launch (policy is evaluated on this)
  client_label    TEXT NOT NULL DEFAULT 'PYB',     -- CLIENT: header line
  project_ref     TEXT,                            -- HubSpot project id when known
  task            TEXT NOT NULL,
  started_by      UUID REFERENCES users(id),
  trigger         TEXT NOT NULL DEFAULT 'console',
  status          TEXT NOT NULL DEFAULT 'starting',
  stop_reason     TEXT,                            -- last session.status_idle stop_reason.type
  budget_cents    INT  NOT NULL,
  list_cost_cents INT,
  last_error      TEXT,
  last_event_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_runs_status_chk CHECK (status IN ('starting', 'running', 'idle', 'requires_action', 'budget_reached', 'rescheduling', 'terminated', 'failed')),
  CONSTRAINT team_runs_trigger_chk CHECK (trigger IN ('console', 'voice', 'mcp', 'fireflies')),
  CONSTRAINT team_runs_portal_kind_chk CHECK (portal_kind IS NULL OR portal_kind IN ('production', 'sandbox', 'test')),
  CONSTRAINT team_runs_portal_pair_chk CHECK ((portal_id IS NULL) = (portal_kind IS NULL)),
  CONSTRAINT team_runs_project_ref_chk CHECK (project_ref IS NULL OR project_ref ~ '^[0-9]{1,20}$'),
  CONSTRAINT team_runs_agent_version_chk CHECK (agent_version > 0),
  CONSTRAINT team_runs_budget_chk CHECK (budget_cents > 0),
  CONSTRAINT team_runs_cost_chk CHECK (list_cost_cents IS NULL OR list_cost_cents >= 0),
  CONSTRAINT team_runs_session_chk CHECK (session_id IS NOT NULL OR status IN ('starting', 'failed')),
  CONSTRAINT team_runs_task_chk CHECK (char_length(task) BETWEEN 1 AND 20000)
);
CREATE INDEX team_runs_created_idx ON team_runs (created_at DESC);
-- Supervisor scan: runs that may still need a stream.
CREATE INDEX team_runs_live_idx ON team_runs (status, updated_at) WHERE status NOT IN ('terminated', 'failed');
CREATE INDEX team_runs_portal_idx ON team_runs (portal_id);

-- Durable seen-ledger for session events (dedupe across reconnects/restarts).
CREATE TABLE team_run_events (
  event_key    TEXT PRIMARY KEY,                   -- event id, or 'anon:<sha256>' for id-less events
  run_id       UUID NOT NULL REFERENCES team_runs(id),
  event_type   TEXT NOT NULL,
  thread_id    TEXT,
  processed_at TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX team_run_events_run_idx ON team_run_events (run_id, received_at);

CREATE TABLE team_pending_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES team_runs(id),
  event_id        TEXT NOT NULL,                   -- tool_use_id for user.tool_confirmation
  thread_id       TEXT,                            -- session_thread_id of a cross-posted subagent ask
  tool_kind       TEXT NOT NULL,                   -- mcp | builtin
  tool_name       TEXT NOT NULL,
  mcp_server      TEXT,
  input           JSONB NOT NULL,                  -- model-produced, capped; data only
  input_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  injection_flags TEXT[] NOT NULL DEFAULT '{}',
  portal_id       UUID REFERENCES team_portals(id),
  portal_kind     TEXT,                            -- snapshot from the run; drives approver role
  status          TEXT NOT NULL DEFAULT 'pending',
  decision        TEXT,                            -- allow | deny
  decision_reason TEXT,                            -- approver | ttl | kill_switch | portal_disabled | external
  deny_message    TEXT,
  decided_by      UUID REFERENCES users(id),
  decided_at      TIMESTAMPTZ,
  last_error      TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_pending_actions_event_key UNIQUE (event_id),
  CONSTRAINT team_pending_status_chk CHECK (status IN ('pending', 'deciding', 'approved', 'denied', 'expired', 'void')),
  CONSTRAINT team_pending_tool_kind_chk CHECK (tool_kind IN ('mcp', 'builtin')),
  CONSTRAINT team_pending_decision_chk CHECK (decision IS NULL OR decision IN ('allow', 'deny')),
  CONSTRAINT team_pending_reason_chk CHECK (decision_reason IS NULL OR decision_reason IN ('approver', 'ttl', 'kill_switch', 'portal_disabled', 'external')),
  CONSTRAINT team_pending_portal_kind_chk CHECK (portal_kind IS NULL OR portal_kind IN ('production', 'sandbox', 'test')),
  CONSTRAINT team_pending_lifecycle_chk CHECK (
       (status = 'pending'  AND decision IS NULL AND decision_reason IS NULL)
    OR (status = 'void')
    OR (status = 'deciding' AND decision IS NOT NULL AND decision_reason IS NOT NULL)
    OR (status = 'approved' AND decision = 'allow' AND decision_reason IS NOT NULL)
    OR (status = 'denied'   AND decision = 'deny'  AND decision_reason IS NOT NULL)
    OR (status = 'expired'  AND decision = 'deny'  AND decision_reason = 'ttl')
  )
);
CREATE INDEX team_pending_actions_queue_idx ON team_pending_actions (status, expires_at);
CREATE INDEX team_pending_actions_run_idx ON team_pending_actions (run_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    -- No DELETE anywhere: runs, asks and the event ledger are evidence.
    GRANT SELECT, INSERT, UPDATE ON team_portals, team_runs, team_pending_actions TO app_rw;
    GRANT SELECT, INSERT ON team_run_events TO app_rw;
  END IF;
END
$$;
```

### 3.6 What every module may assume

- `src/products/team/catalog.ts`, `types.ts` and `memoryStore.ts`, and
  `src/integrations/anthropic/managedAgents.ts` exist and typecheck.
- `pnpm typecheck` is green on the contracts commit. `team_control` is in
  `AGENTS` and `AGENT_SCOPES`, and the new audit unions and config are present.
- Unit tests set `process.env` before importing config, as
  `credentials.test.ts` does, or inject `cfg: Config['team']` objects directly.
  The second is preferred: all team deps take `cfg` explicitly.

## 4. Order

1. **Contracts commit (orchestrator):** §3.0–3.5, then `pnpm typecheck`.
2. **Parallel:** M1, M2, M3, M4, M5 and M6. Each builds against §3 and tests
   with `InMemoryManagedAgents` / `InMemoryTeamStore` and fakes of
   `TeamGate` / `TeamLauncher` / `AuditSink` / `SodPort`. No module imports
   another module's implementation file, with two exceptions that only compile
   after merge:
   - **M4's `src/worker.ts` block** imports `SdkManagedAgentsClient` (M1),
     `PgTeamStore` (M2) and `createTeamGate` (M5).
   - **M6's `src/index.ts` wiring** imports M1, M2, `createTeamLauncher` +
     `loadLockfile` (M3) and M5.

   The names are fixed in §2, so the code can be written in parallel.
3. **Merge order:** M1 → M2 → M5 → M3 → M4 → M6. Typecheck after each. M4 and
   M6 last because of the wiring imports.
4. `/review` on the full diff, then `/ship`.
   - The PR body lists migration `0006_team_control.sql`, the new env vars
     (§3.0), the new dependency `@anthropic-ai/sdk@<exact>`, and new
     permissions to grant to roles out of band (`team:view`, `team:run`,
     `team:approve`, `team:approve_production`, `team:portals`, `team:budget`).
   - The admin `*` role already has all of them.

## 5. Governance checks

| Path | Kill-switch | Audit event | Credential / egress | Validation | Enforced by |
|---|---|---|---|---|---|
| Any HTTP to Anthropic | – | – | `getScopedSecret('team_control','anthropic')` per request; `assertEgressAllowed('team_control', url.hostname)` + https/no-port; explicit `baseURL` | URL parsed, host compared exactly | `createGovernedFetch` (M1) |
| Start run (console POST → sessions.create + user.message) | `isWritesFrozen()` refuses writing roles (`spec.writes`) | `team_run_started` / `team_run_failed` | via governed fetch | `StartRunInput` (strict zod, UUID portal, numeric project ref, length caps); catalog `launchable`; portal enabled + `allowedPortalKinds`; one HubSpot vault from the chosen portal only; header fields `sanitize()`d | `createTeamLauncher().start` (M3); CSRF + `team:run` + sudo in `registerTeamRoutes` (M6) |
| Follow-up message | refused for writing roles when frozen | `team_run_message` | governed fetch | `FollowUpText`; run active and not `requires_action`/`budget_reached`; `sanitize()` | `launcher.followUp` (M3); CSRF + `team:run` (M6) |
| Interrupt | always allowed (stops work) | `team_run_interrupted` | governed fetch | run UUID, has session | `launcher.interrupt` (M3) |
| Raise budget (sessions.update) | refused for writing roles when frozen | `team_budget_changed` | governed fetch | integer cents, > cost, > current, ≤ `TEAM_MAX_BUDGET_CENTS` | `launcher.raiseBudget` (M3); `team:budget` + sudo (M6) |
| Approve/deny ask (user.tool_confirmation) | allow → forced deny with `DENY_MESSAGES.kill_switch` | `team_action_decided` (+ `sod_action_log` approved/rejected) | governed fetch | action UUID; atomic `claimDecision`; perm by `portal_kind` (`team:approve` / `team:approve_production`); SoD: actor never `configured` `team_run:<id>` or `team_portal:<id>`; deny message `sanitize(…,1000)` | `createTeamGate().decide` (M5); CSRF + sudo (M6) |
| New ask while frozen / portal disabled | immediate system deny | `team_action_pending` then `team_action_decided` | governed fetch | — | `gate.onNewAsk` (M5) called from `processEvent` (M4) |
| Kill-switch engaged with asks pending | every `pending` ask denied within one supervisor tick (5 s) | `team_action_decided` (`kill_switch`) | governed fetch | — | `supervisor` tick → `gate.enforceKillSwitch` (M4/M5) |
| TTL | — | `team_action_decided` (`ttl`, status `expired`) | governed fetch | `expires_at` set at insert from `TEAM_APPROVAL_TTL_HOURS` | `gate.expireStale` (M5) every 60 s |
| Receiving events (untrusted) | — | `team_session` per event, payload `redact()`ed by the writer **and** capped to 16 KB by `capForAudit` | governed fetch | `looseObject` envelope parse; model `input` stored as opaque capped JSON; `scanForInjection` flags stored on the ask | `processEvent` (M4) |
| Rendering agent output in the console | — | — | — | `esc()` everywhere; 4 KB render cap; injection badge; never raw HTML | `teamViews.ts` (M6) |
| Portal add/toggle, budgets setting | — | `config_change` (product `team`) + SoD `configured` | none (vault id only, never a token) | `PortalInput` (numeric hubspot id, `vlt_` regex, kind enum), DB CHECKs, one production portal; `TeamBudgetsInput` + max check | `registerTeamRoutes` (M6); DB constraints (§3.5) |
| Slack ping on new ask | — | — | existing `orchestrator` scope via `Notifier` | tool name `sanitize(…,64)`; no agent text in the ping | `processEvent` (M4) |
| Caller-supplied ids | — | — | — | route `:id` → `z.uuid()`; `hubspotId`/`projectRef` numeric; vault ids regex; session/event ids come from the API, not callers, and are passed to the SDK, which path-encodes them | M6 routes, `types.ts` schemas |

Secrets: the app adds no new secret. HubSpot, Fireflies and GitHub credentials
for team sessions exist only in Anthropic vaults, and `HUBSPOT_ACCESS_TOKEN` is
never passed to a session. Fixtures use fake ids such as `vlt_test_1` and
`agent_test_pm`.

## 6. Test plan

**M1** (`governedFetch.test.ts`, `managedAgentsSdk.test.ts`; unit tests with an
injected `inner` fetch):

- Refuses `http:`, a non-default port, and any host other than
  `api.anthropic.com`, both through the scope and through `EGRESS_ALLOWLIST`.
  `inner` is never called.
- Sets `x-api-key` from scope and strips `authorization`. Never forwards the
  placeholder.
- Throws `CredentialScopeError` when `ANTHROPIC_API_KEY` is unset.
- `createSession` sends the exact body:
  - `agent: {type:'agent', id, version}`, `environment_id`, `vault_ids`
  - `budget.max_list_cost: { amount: '1000', currency: 'USD' }`
  - title and metadata
- `sendToolConfirmation` omits `deny_message` for allow and includes it for
  deny. `tool_use_id` is the event id.
- `listEvents` follows pagination (two pages from a fake) and drops malformed
  items.
- `openEventStream` yields parsed SSE events from a fake `text/event-stream`
  body and ends when the body ends or the signal aborts.
- `retrieveSession` maps `usage.list_cost.amount` `'1234'` to `1234`.

**M2** (`store.itest.ts`, against Postgres; `resetAndMigrate`):

- Migration applies on a clean DB, and the grants block is a no-op without
  `app_rw`.
- `team_portals`:
  - Rejects a non-numeric hubspot id, a bad vault id and an unknown kind.
  - A duplicate hubspot id fails.
  - A second production portal fails; a second sandbox succeeds.
- `team_runs`:
  - `session_chk`: `running` without a session id fails.
  - `portal_pair_chk`.
  - A bad `project_ref` fails.
- `listStreamableRuns` includes `running`, `requires_action` and recent `idle`.
  It excludes old `idle`, `terminated` and `failed`.
- `markEventSeen` is idempotent and `hasSeenEvent` flips.
- `insertPendingAction` with a duplicate `event_id` returns `inserted:false`
  with the same row.
- `claimDecision`: two concurrent claims (`Promise.all`) → exactly one non-null.
- `finalizeDecision` produces approved / denied / expired by decision and reason.
- The lifecycle CHECK rejects `approved` with `decision='deny'`.
- `revertDecision` → pending with the decision cleared.
- `settleFromEcho`:
  - pending → approved, `external`, `wasOurs:false`
  - deciding → `wasOurs:true`
  - terminal → null
- `listExpired`, `listStuckDeciding`, `voidPendingForRun` count.

**M3** (`launcher.test.ts`, `lockfile.test.ts`, `header.test.ts`,
`budgets.test.ts`; unit tests with `InMemoryManagedAgents` +
`InMemoryTeamStore`):

- Happy path:
  - One `creates[]` entry with the portal vault only (plus the Fireflies vault
    for PM).
  - Budget from the catalog → settings → config precedence.
  - Run `idle` with a session id.
  - SoD `configured` recorded for `team_run:<id>`.
  - `team_run_started` audited.
  - Kickoff text starts with `CLIENT:` and contains all six header lines in
    order.
- Refusals, each a typed `TeamError` with **no** create call:
  - `not_launchable` (orchestrator)
  - `portal_kind_not_allowed` (PM on production)
  - `portal_disabled`
  - `portal_required`
  - `kill_switch` for a writing role
  - `vault_not_configured` (PM without `TEAM_FIREFLIES_VAULT_ID`)
  - `lockfile_missing`
- Kill-switch does **not** block a read-only role.
- `createSession` failure → run `failed` + `team_run_failed`. Kickoff failure →
  run `idle`, `lastError` set, `team_run_failed{stage:'kickoff'}`.
- `followUp`:
  - Refused on `requires_action` (`run_busy`) and `terminated`
    (`run_not_active`).
  - The text passes through `sanitize`, so `<system>` is neutralised.
  - Sets status `running`.
- `interrupt` works with the kill-switch on.
- `raiseBudget` rejects ≤ cost, ≤ current and > max. It calls `updateBudget`
  with cents.
- Lockfile:
  - A missing file → `{ok:false}`.
  - Bad JSON → `{ok:false}`.
  - Extra top-level keys are tolerated.
  - A numeric-string version is coerced.
  - One malformed agent entry gives a warning while the others still resolve.
  - `normalizeSlug('PYB Project-Manager') === 'project_manager'` and
    `normalizeSlug('pyb-office') === 'office'`.
- Header: a newline in the client label is collapsed. `PORTAL: none` when there
  is no portal.

**M4** (`events.test.ts`, `stream.test.ts`, `supervisor.test.ts`; unit tests):

- `parseTeamEvent`:
  - Each mapped type.
  - An `agent.mcp_tool_use` with `evaluated_permission:'allow'` is `other`, not
    an `ask`.
  - A subagent ask keeps `threadId`.
  - An unknown type → `other`.
  - Extra fields are tolerated.
  - `usage.list_cost.amount: '250'` → 250.
- `eventKey` hashes id-less events stably.
- `processEvent`:
  - Second delivery of the same id → `duplicate:true`, no audit, no store
    writes.
  - An ask creates one pending action with `expiresAt = now + ttl`,
    `team_action_pending` is audited, `notify` is called, and
    `gate.onNewAsk` is called once.
  - The same ask replayed via list is not duplicated.
  - Large input → `inputTruncated:true`.
  - Injection text in the input → `injectionFlags` set.
  - Idle with `requires_action` / `budget_reached` / `end_turn` maps the status.
  - `terminated` voids pending asks and returns `terminal:true`.
  - A confirmation echo with no decision from us → `external` audit.
  - A `notify` throw does not fail processing.
  - A store throw propagates.
- Supervisor (fake `sleep`, `tickMs:0`):
  - Opens one stream per streamable run and none for terminated runs.
  - Events emitted with `historyOnly` during a gap are picked up after
    `dropStreams` → reconnect, via list, exactly once.
  - Closes the stream when a run leaves the streamable set.
  - Calls `gate.enforceKillSwitch` only while frozen, and
    `expireStale` / `reconcileStuck` on housekeeping.
  - A `retrieveSession` showing `terminated` fixes DB state.
  - `run()` returns promptly after `stopped()` and leaves no open streams
    (`openStreamCount === 0`).

**M5** (`gate.test.ts`; unit tests with both twins and a fake `SodPort`):

- Approve as a non-configurer → confirmation `allow` sent with `toolUseId =
  eventId`. Status `approved`, SoD `approved`, audit `team_action_decided`.
- Approve by the run starter or the portal configurer → `sod_denied`, nothing
  sent, still pending. A deny by the same person is allowed.
- `team:approve` alone on a production ask → `permission_denied`. With
  `team:approve_production` → ok.
- Allow while frozen → a deny is sent with the kill-switch message,
  `forced:true`, status `denied`, reason `kill_switch`.
- Portal disabled → forced deny.
- Run terminated → `void`, nothing sent.
- Two concurrent `decide` calls → exactly one sends. The other gets
  `action_already_decided`.
- `sendToolConfirmation` failure → reverted to `pending` with `lastError`,
  `send_failed` audited, error rethrown.
- `expireStale` → deny sent, status `expired`.
- `enforceKillSwitch` denies all pending.
- `onNewAsk` denies when frozen and is a no-op otherwise.
- `reconcileStuck` reverts old `deciding` rows only.

**M6** (`teamPanels.test.ts`; Fastify inject, same fakes as `console.test.ts`):

- Each GET 302s to login without a session and 403s without its permission.
- Pages render "not enabled" when `deps.team` is absent.
- Every POST:
  - Rejects a missing or bad CSRF token (403).
  - Redirects to sudo where marked.
  - Rejects a non-UUID `:id` (404).
- Start-form POST → `launcher.start` with `startedBy = user.id` and
  `trigger:'console'`. A `TeamError` renders a flash, not a 500.
- Approvals page escapes a `<script>` in the tool input and shows the
  injection badge.
- The approve POST calls `gate.decide` with the actor's permissions.
- The portal POST with an invalid vault id shows a flash and makes no store
  call. A valid one records SoD `configured` + `config_change`.
- The Agents page no longer lists `team_control`.
- NAV shows Team only with `team:view`.

**Integration (`*.itest.ts`):** `store.itest.ts` (M2) covers the full SQL
surface above. No other module touches Postgres directly.

## 7. Out of scope / open questions

**Deliberately out of scope (phases 0, 3, 4):**

- `agents/pyb/` definitions and `ant apply`, which write the real
  `claude-lock.json`.
- Orchestrator runs: the catalog has `launchable:false`.
- Developer, QA and Migration roles.
- Voice HUD and `/mcp` `team_*` tools.
- The `TEAM_MEETING_RUNS` Fireflies → PM trigger.
- Anthropic webhooks as the wake signal (would replace the permanent streams;
  `processEvent` is reusable as-is).
- OpenTelemetry and per-portal cost reports.
- Custom-tool fallback for credentials.
- Per-client portals and client-portal OAuth: dropped by the single-tenant
  decision.
- Downloading session output files (e.g. the solution brief in
  `/mnt/session/outputs`) into the console. Phase 1 shows the agent's messages in
  the timeline and a Console deep link instead (see Q8).

**Decisions taken by the orchestrator (2026-10-26), reflected in §2 above:**

- Q3: SoD (approver ≠ run starter / portal configurer) is enforced for
  `production` asks only; sandbox/test asks may be approved by the starter
  (audited as `selfApproved: true`). Single-operator UAT would otherwise be
  impossible.
- Q7: a missing shared vault (Fireflies/GitHub) does not block a launch; the
  server is not attached and the audit records it.
- Q8: timeline + Console deep link is enough for phases 1–2; file download is
  phase 3.
- Q9: `span.*` events go to `team_run_events` only, not to `audit_log`.
- Q11: `@anthropic-ai/sdk` is added, pinned exactly (`1.3.0`, the first release
  with `beta.sessions.events.stream` verified in this repo's probe).
- Q5/Q6: defaults stand until real runs.

**Still open for the owner:** Q1 (confirm slugs/environments against
`agents/pyb` when phase 0 lands), Q2 (vault id format), Q4 (who holds
`team:approve_production`), Q10 (who performs the HubSpot MCP OAuth flow).

**Open questions for the owner (original list):**

1. **`claude-lock.json` format and names.** Assumed to be
   `{ agents: { <name>: { id, version } }, environments: { <name>: { id } } }`.
   - The loader is tolerant and normalises names onto the nine catalog slugs and
     `pyb-office | pyb-build | pyb-migration | pyb-orchestrated`.
   - The slugs, the agent → environment mapping, and the "writes" flag per role
     (§3.2) are inferred from the architecture doc, not from the agent files,
     which are not in the repo yet. Please confirm against the zip when phase 0
     lands. Changing the catalog is a one-file edit.
2. **Vault and session id formats.** Assumed `vlt_…`. It is enforced by regex in
   config, zod and a DB CHECK. If real ids differ, the CHECK needs a follow-up
   migration.
3. **Approver ≠ configurer scope.** The plan forbids approving a write for:
   - the person who started the run or sent it a follow-up;
   - the person who added or toggled the portal.

   With one admin that means a second person is required for every approval.
   Should the run-starter rule be relaxed for `test` portals?
4. **Production approval role.** Who holds `team:approve_production`, and should
   production writes need two approvers (doc §7 Q5)? In phases 1–2 no writing
   role can target production, so this only matters for asks from read-only
   roles (which should be rare).
5. **Budgets.** Defaults are $10 per specialist (orchestrator $40, not
   launchable yet) and a $100 raise ceiling (`TEAM_MAX_BUDGET_CENTS`). Confirm
   after a few real runs (doc §7 Q6).
6. **Approval TTL.** 24 h by default. Is a shorter TTL wanted for sandbox?
7. **Fireflies MCP vault credential type** (doc §7 Q2). The Project Manager and
   Solutions Architect declare Fireflies. Until `TEAM_FIREFLIES_VAULT_ID` is
   set, they refuse to launch with `vault_not_configured`. Should they instead
   launch without Fireflies and take the transcript id in `INPUTS:`?
8. **Phase 1 "brief visible in the console".** Fetching session output files
   needs the Files/session-outputs API, which this plan does not wire. Is the
   timeline (agent messages) plus a Console deep link (`ANTHROPIC_WORKSPACE_ID`)
   acceptable for phase 1, or should file download be added as a seventh module?
9. **Audit volume.** Every persisted session event (including `span.*`) is
   chained into `audit_log` as the doc requires. A long run can add thousands of
   rows. Is that acceptable, or should `span.*` events go only to
   `team_run_events`?
10. **HubSpot MCP OAuth for PYB's own portals.** This is still needed for the
    production and sandbox vaults (doc §7 Q1, simplified to single tenant). Who
    performs the one-off OAuth flow that seeds each vault?
11. **SDK version.** M1 pins the newest `@anthropic-ai/sdk` release that is at
    least two weeks old and exposes `beta.sessions.events.stream`. Confirm there
    is no org policy against adding the dependency (the repo has used hand-rolled
    `fetch` adapters until now).
