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

### Orchestration & resolution (build-order step 2 — not yet implemented)
- Independent agents run in parallel.
- Resolution consults the **safe/unsafe table** (`resolution_policy`): each
  finding is either auto-fixed or escalated, with reversibility recorded.
- **Security veto is non-overridable on its own domain**; **CTO breaks
  non-security ties**.
- A subject proceeds only if all required agents `pass` (or are auto-fixed to
  pass). Everything is logged to `audit_log`.

### Governance layer
- **Untrusted-input handling** (`src/core/agents/sanitize.ts`): strip control
  chars, neutralise fake role markers, length-cap.
- **Output-side injection scanning**: every agent's free-text output is
  untrusted input to the next stage; suspicious output is **quarantined to
  audit, not dropped**.
- Per-agent scoped credentials, egress allowlist, secret-scan + redact before
  any log/audit write.

### Audit log
- Hash-chained (`src/core/audit/hashChain.ts`) → tamper-evident.
- Append-only DB grant for the app role (no UPDATE/DELETE) → tamper-resistant.
- Off-box shipping → survives console compromise.

## Build order & status

| Step | Description | Status |
|------|-------------|--------|
| 1 | Scaffold, config/secrets, full Postgres schema | ✅ done |
| — | Core contracts: agent verdict schema + validation, audit hash-chain, untrusted-text sanitizer | ✅ done (foundation) |
| 2 | Orchestrator (Security veto), safe/unsafe resolution, audit writer + off-box shipping | ⬜ todo |
| 3 | Governance primitives wired into pipeline, secret scanning + log redaction | ⬜ todo |
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
