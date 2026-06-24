# Architecture

## Overview

Two products share one set of infrastructure. The shared core is an agent
framework + orchestrator + governance layer + audit log + datastore. Each
product is a module that drives the shared core through its own pipeline.

```
                         ┌─────────────────────────────────────────┐
                         │              Shared core                 │
  Fireflies webhook ──▶  │  triggers → orchestrator → review board  │  ──▶ HubSpot (Projects + Tasks)
  GitHub repo (on-demand)│   (Security veto, CTO tie-break)         │  ──▶ Scorecard (console)
                         │  governance: untrusted-input handling,   │
                         │  output-side injection scan, egress       │
                         │  allowlist, secret redaction              │
                         │  audit_log: hash-chained, append-only,    │
                         │  off-box shipped                          │
                         └─────────────────────────────────────────┘
                                   │
                            Postgres (DO Managed)
```

## Components

### Shared core agent framework
Seven roles: **Orchestrator/Router** (runs the board, not a voter) plus six
board agents — **Project Manager, HubSpot Admin, Security, Data Quality/
Extraction, Dev, CTO/Architect**.

- Every board agent returns a **strict-JSON verdict** (`src/core/agents/contract.ts`),
  schema-validated before the orchestrator acts.
- Agents are **readers/proposers, not actors** — they emit verdicts and proposed
  fixes; the orchestrator + sync layer are the only side-effecting actors.
- Prompts/model/enabled are editable from the console, stored in `agent_configs`,
  and **versioned**.

### Orchestration & resolution (build-order step 2 — implemented)
- Independent agents run in parallel.
- Resolution (`src/core/orchestrator/resolution.ts`, pure/testable) consults the
  **safe/unsafe table** (`resolution_policy`, loaded via `policy.ts`): each
  finding is auto-fixed (only if reversible **and** policy-sanctioned) or
  escalated, with reversibility recorded. Deny-by-default: anything not
  positively classified escalates.
- **Security veto is non-overridable on its own domain** — a failing Security
  verdict on a security matter always routes to a human and can never be
  tie-broken away. **CTO breaks ambiguous non-security ties.**
- A subject proceeds only if all required agents `pass` (or every failure is a
  reversible auto-fix). Everything is logged to `audit_log` via the writer.

### Governance layer (build-order step 3 — implemented)
- **Untrusted-input handling** (`src/core/agents/sanitize.ts`): strip control
  chars, neutralise fake role markers, length-cap.
- **Output-side injection scanning** (`src/core/governance/outputGuard.ts`):
  every agent's free-text output (`context`, `proposed_fix`, issue messages) is
  untrusted input to the next stage; suspicious output is **quarantined to audit,
  not dropped** (`guardVerdictOutput` returns an audit-ready payload and withholds
  the verdict from resolution).
- **Per-agent credential & egress scoping** (`src/core/governance/credentials.ts`):
  deny-by-default registry mapping each agent to the exact secrets and egress
  hosts it may use; `assertEgressAllowed`/`getScopedSecret` enforce it in code.
  The HubSpot service key is scoped to `hubspot_admin` only.
- Secret-scan + redact before any log/audit write (`src/core/audit/redact.ts`).

### Audit log (build-order step 2 — implemented)
- Hash-chained (`src/core/audit/hashChain.ts`) → tamper-evident.
- Append-only DB grant for the app role (no UPDATE/DELETE) → tamper-resistant.
- Writer (`src/core/audit/writer.ts`) redacts secrets (`redact.ts`) **before**
  hashing/storing, serialises appends with a transaction-scoped advisory lock so
  the chain is computed against a stable tail, and writes `created_at`
  explicitly so each row is independently re-verifiable.
- Off-box shipping (best-effort, post-commit) → survives console compromise.

### Trigger registry (build-order step 4 — implemented)
Three trigger kinds in `trigger_configs`, loaded + spec-validated via
`triggers/registry.ts`: `webhook`, `cron`, `on_demand`.
- **Webhook receiver** (`web/webhookReceiver.ts`, Fastify plugin) layers, before
  any worker sees the payload: body-size cap → rate limit by IP **and** source
  (`triggers/rateLimiter.ts`) → constant-time HMAC over `${timestamp}.${body}`
  (`triggers/webhookVerify.ts`, `crypto.timingSafeEqual`) → timestamp tolerance
  window → delivery-ID replay dedupe (`triggers/dedupe.ts`, atomic
  `ON CONFLICT DO NOTHING`). Every receipt is recorded for forensics; fresh
  valid deliveries are audited and handed to the worker.
- **Cron** runs are made idempotent across worker instances with a Postgres
  advisory try-lock keyed by a stable hash of the job key
  (`triggers/cronLock.ts`) — no double-fire, no blocking.
- **On-demand** ("run now") triggers carry an `action` spec.

### HubSpot integration (build-order step 5 — implemented)
Everything talks to the `HubSpotClient` **port** (`integrations/hubspot/`), never
a concrete adapter:
- **Agent CLI** adapter (`agentCli.ts`) — primary per the brief; invokes the CLI
  via `execFile` with an argv array (no shell). The CLI subcommand/flag surface
  is **beta/pending verification**, so it is opt-in.
- **Projects API** adapter (`projectsApi.ts`) — documented fallback and the
  default. Version-pinned (`/crm/objects/<version>/projects`), egress-guarded
  (`assertEgressAllowed`), admin-mode owner resolution via the service key.
- **In-memory** adapter — deterministic, for tests/dry-run demos.
- `buildSyncPlan` (`plan.ts`, pure) turns board-approved, reconciled items into
  create-or-update ops, dropping `skipped_duplicate` items (no duplicates).
- `runSync` (`sync.ts`) enforces **dry-run-first** (always preview, logged to
  `sync_log`) and **board-approved-only** apply; empty plans short-circuit.

> HubSpot-side specifics (Hub tier, Projects-object availability, OAuth scopes,
> exact CLI surface and association type ids) are open "remaining confirmations"
> in the brief. The adapter *structure* — port, version pinning, egress guard,
> admin-mode owner resolution — is final; only those Hub-side details are pending.

## Products

### Product A — Meeting→Task Engine (build-order step 6 — implemented)
The worker pipeline (`products/meeting/`) runs after the webhook receiver has
verified + enqueued a delivery:
- **Extraction** (`extract.ts`) — transcript is sanitised + length-capped, then
  an `LlmExtractor` (Anthropic behind the `LlmClient` port) returns strict-JSON
  action items, each carrying a `source_quote` (anti-hallucination provenance).
- **Reconciliation** (`reconcile.ts`) — items normalise to a stable `item_hash`;
  an atomic `INSERT … ON CONFLICT DO NOTHING` on `reconciliation_ledger` decides
  create-vs-duplicate, so re-delivery never duplicates work.
- **Board** (`board.ts`) — one batched call per agent over all items; each
  verdict is schema-validated and run through the output-injection guard
  (quarantine, don't drop), then resolved per item by the orchestrator engine.
- **Sync** — proceeding items become a `buildSyncPlan` → `runSync` (dry-run →
  board-approved apply); escalated items go to `escalation_queue`. Every stage
  is audited.
- **Query agent** (`query.ts`) — "what did I commit to" answered from the
  ledger/sync provenance, not re-derived from transcripts.

LLM calls (extraction + board) sit behind the `LlmClient` port (Anthropic
adapter + stub), so the pure logic (reconciliation, resolution, pipeline flow)
is fully unit-tested without network.

## Admin console (build-order step 7 — security core implemented)
The highest-risk surface, so the security-critical logic is built as pure,
unit-tested modules (`src/console/`); the console's HTTP routes + UI are thin
wiring over these and are the remaining piece.
- **Auth** (`console/auth/`):
  - `totp.ts` — RFC 6238 MFA, constant-time, skew window, no deps.
  - `password.ts` — pluggable `PasswordHasher` (built-in scrypt default; argon2id
    is the documented production swap) + strength policy (zxcvbn is the prod
    target; conservative built-in stand-in here).
  - `hibp.ts` — HaveIBeenPwned **k-anonymity** breach check (only the 5-char
    SHA-1 prefix leaves the process; suffix matched locally).
  - `session.ts` — idle + absolute timeouts, server-side revocation, sudo
    re-auth window, refresh tokens stored only as hashes (constant-time verify).
  - `lockout.ts` — lockout transitions + `dummyVerify` for enumeration-resistant
    timing.
  - `csrf.ts` — double-submit token (constant-time).
- **RBAC** (`console/rbac/`):
  - `permissions.ts` — deny-by-default `resource:action` grants (+ wildcards).
  - `sod.ts` — separation of duties: a subject's configurer **cannot
    self-approve** it; enforced in code, evidenced in `sod_action_log`.
- **Kill-switch** (`console/killswitch.ts`, migration 0002) — single shared flag
  freezing all external writes; the meeting pipeline checks it and downgrades to
  preview-only when engaged (no crash, still audited).

## Deployment & crypto (build-order step 8 — implemented)
- **`.do/app.yaml`** — DigitalOcean App Platform spec: a **web** service (Fastify)
  + a **worker** (`src/worker.ts`, async jobs) + a PRE_DEPLOY **migrate** job, all
  on DO Managed Postgres. Secrets are App Platform secrets (SECRET-typed), never
  in the repo.
- **Least-privilege role** — `scripts/provision-roles.sql` creates `app_rw`; the
  migrations grant it INSERT+SELECT-only on `audit_log` (append-only).
- **Envelope encryption** (`core/crypto/envelope.ts`) — per-record AES-256-GCM
  data key wrapped by the master KEK; self-describing, key-versioned blob so the
  KEK rotates while old records stay readable. Used for `raw_artifacts.content_enc`
  and TOTP seeds.

## Product B — Repo Scoring (build-order step 9 — implemented)
On-demand pipeline (`products/repo/`):
- **Ingest** (`ingest.ts`) — read-only, never-execute parser over the cloned
  repo (assumed cloned in an isolated, network-restricted, ephemeral context):
  resource caps (file count / total / per-file bytes), symlink rejection,
  path-escape rejection.
- **Pre-scan** (`prescan.ts`) — **before any content reaches Anthropic**: flags
  committed secrets/dangerous artefacts and produces a **redacted** view, so
  secrets never reach the model.
- **Board** (`score.ts`) — Dev + Security + CTO reviewers (LLM behind a port),
  each a 0–100 dimension score; aggregated into a scorecard.
- **Pipeline** (`pipeline.ts`) — ingest → pre-scan (audited) → board → scorecard
  → audit persist.

## Scalability & operations (enterprise hardening)

Layered on the build-order steps after a code review:
- **Async decoupling** — the webhook receiver enqueues a durable job
  (`jobs` table, migration 0003, idempotent on delivery id); worker instances
  claim with `FOR UPDATE SKIP LOCKED` and run the pipeline. Many workers drain
  concurrently; failures retry with backoff then dead-letter. Burst ingestion is
  decoupled from slow LLM/sync work.
- **Resilient external calls** — `core/net/resilientFetch.ts` adds timeout,
  retry-with-jitter, and a per-host circuit breaker; used by every adapter.
- **Board resilience** — `runBoard` uses `allSettled`; a single agent's LLM
  failure can't fail the batch (its subjects fail closed to escalation).
- **DB at scale** — batched audit appends (one advisory-lock acquisition per
  run, not per row), single-statement reconciliation + escalation inserts,
  configurable pool size (`DATABASE_POOL_MAX`), PgBouncer (transaction mode)
  recommended across instances. A shared **Postgres-backed rate limiter**
  (`pgRateLimiter.ts`, migration 0004) replaces the per-instance limiter for
  multi-instance deploys.
- **Observability** — one pino structured logger (web + worker) with a
  correlation id (request/job) in AsyncLocalStorage; Prometheus `/metrics`
  (`prom-client`): jobs by outcome, board latency, sync outcomes, escalations,
  queue depth.
- **Production auth** — argon2id password hashing (scrypt retained for legacy
  verify + transparent rehash) and zxcvbn strength scoring.
- **Verification** — DB-layer SQL is covered by a real-Postgres integration
  suite (`*.itest.ts`) run in CI against a service container; the unit suite
  stays fast and DB-free.

## Build order & status

| Step | Description | Status |
|------|-------------|--------|
| 1 | Scaffold, config/secrets, full Postgres schema | ✅ done |
| — | Core contracts: agent verdict schema + validation, audit hash-chain, untrusted-text sanitizer | ✅ done (foundation) |
| 2 | Orchestrator (Security veto), safe/unsafe resolution, audit writer + off-box shipping | ✅ done |
| 3 | Governance primitives wired into pipeline, secret scanning + log redaction | ✅ done |
| 4 | Trigger registry: webhook (replay protection, constant-time sig, rate limits) + cron + on-demand | ✅ done |
| 5 | HubSpot integration: Agent CLI wrapper + Projects API fallback + admin-mode owner resolution + egress allowlist | ✅ done |
| 6 | Product A full path | ✅ done |
| 7 | Admin console: auth + MFA + sudo-mode + SoD RBAC, editors, escalation queue, audit viewer, kill-switch | 🟡 security core done; HTTP/UI wiring pending |
| 8 | DO App Platform deploy (web + worker), append-only audit role, envelope keys | ✅ done |
| 9 | Product B: sandboxed GitHub ingest → pre-scan → Dev/Security/CTO board → scorecard | ✅ done |

## Locked decisions (from the brief)

- **HubSpot:** native Projects object + associated Tasks. Projects API base
  `/crm/objects/2026-03/projects`, version **pinned**. HubSpot Agent CLI is the
  primary integration; the version-pinned Projects API is the documented fallback.
- **LLM:** Anthropic only, commercial API terms (no training on inputs).
- **Console auth:** roll-your-own email+password + RBAC, hardened with MFA,
  sudo-mode, and separation of duties.

## Notable design points

- **Roster count:** the brief says "6 agents" then lists seven names. We model
  **Orchestrator/Router as the orchestrator** (not a board voter) and the
  remaining six as board agents (`BOARD_AGENTS`). This reconciles the count.
- **Migrations are forward-only and immutable** once committed (ISO 9001 change
  control) — add a new file rather than editing an applied one.
