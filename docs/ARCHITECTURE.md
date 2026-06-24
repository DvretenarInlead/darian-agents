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

## Build order & status

| Step | Description | Status |
|------|-------------|--------|
| 1 | Scaffold, config/secrets, full Postgres schema | ✅ done |
| — | Core contracts: agent verdict schema + validation, audit hash-chain, untrusted-text sanitizer | ✅ done (foundation) |
| 2 | Orchestrator (Security veto), safe/unsafe resolution, audit writer + off-box shipping | ✅ done |
| 3 | Governance primitives wired into pipeline, secret scanning + log redaction | ✅ done |
| 4 | Trigger registry: webhook (replay protection, constant-time sig, rate limits) + cron + on-demand | ⬜ todo |
| 5 | HubSpot integration: Agent CLI wrapper + Projects API fallback + admin-mode owner resolution + egress allowlist | ⬜ todo |
| 6 | Product A full path | ⬜ todo |
| 7 | Admin console: auth + MFA + sudo-mode + SoD RBAC, editors, escalation queue, audit viewer, kill-switch | ⬜ todo |
| 8 | DO App Platform deploy (web + worker), append-only audit role, envelope keys | ⬜ todo |
| 9 | Product B: sandboxed GitHub ingest → pre-scan → Dev/Security/CTO board → scorecard | ⬜ todo |

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
