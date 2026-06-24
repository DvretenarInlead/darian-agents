# Build Brief v2: Agent-Orchestration Platform (Meeting→Task + Repo-Scoring)
## Security-hardened, ISO 9001 / 27001 / 42001 aligned

> This document is the source build brief that this repository implements. It is
> reproduced here as the canonical reference; `ARCHITECTURE.md`, `SECURITY.md`,
> and `COMPLIANCE.md` distil it into actionable, status-tracked form.

> **What changed from v1:** This revision keeps the original architecture intact
> and adds a first-class, certification-grade security and management-system
> layer. The three certifications target different things and are handled
> distinctly: **ISO 9001** = quality management, **ISO 27001** = information
> security (Annex A 2022, 93 controls / 4 themes), **ISO 42001** = AI management
> system (AIMS, Annex A 38 controls / 9 domains). None is satisfied by code
> alone — each also requires documented management-system processes.

## What this is

A shared agent-orchestration platform hosting **two products** on common
infrastructure, with a full admin console and a first-class governance/security
layer.

- **Product A — Meeting→Task Engine:** ingests Fireflies meeting data via
  webhook, extracts action items with an LLM, reconciles against existing
  HubSpot data to avoid duplicates, runs a multi-agent review board, then syncs
  approved items into HubSpot as **Projects + associated Tasks**. Includes a
  query agent.
- **Product B — Repo Scoring:** on request, ingests a GitHub repo and runs a
  review board (Dev + Security + CTO) that scores code and integration quality.

Two separate products sharing infrastructure: one agent framework, one
orchestrator, one admin console, one governance layer, one audit log, one
datastore. Product-specific logic lives in its own module.

## Locked decisions

- **HubSpot data model:** native **Projects object** + associated Tasks (NOT a
  queue/custom-property hack). Projects API base
  `/crm/objects/2026-03/projects` — **pin this dated version**. Required props:
  `hs_name`, `hs_pipeline`, `hs_pipeline_stage`. Useful: `hs_description`,
  `hs_status`, `hs_target_due_date`, `hs_type`, `hubspot_owner_id`.
- **LLM provider:** **Anthropic, commercial API terms** (no training on inputs).
- **Admin console auth:** **roll-your-own** email+password + RBAC — hardened with
  MFA, sudo-mode, separation of duties. Highest-risk surface.
- **HubSpot integration:** **HubSpot Agent CLI** (public beta) primary; **direct
  Projects API (version-pinned) as documented fallback**.

## Stack & hosting

- **Runtime:** TypeScript (Node).
- **Hosting:** DigitalOcean App Platform — web service + worker for async jobs.
- **Persistence:** DigitalOcean Managed Postgres + app-level envelope encryption
  for the most sensitive columns + an append-only application role for the audit
  table.
- **Secrets:** DO app secrets / env vars, per-agent scoped credentials, no
  secrets in repo, documented rotation cadence, CI secret-scanning.

## Security (folded into the build)

1. **Webhook & ingestion hardening:** replay protection (timestamp window +
   nonce/delivery-ID dedupe), constant-time signature comparison
   (`crypto.timingSafeEqual`), payload size + rate limits, pinned TLS verification.
2. **Console auth:** MFA/TOTP, password policy + breach check (zxcvbn + HIBP),
   session hardening, CSRF, enumeration-resistant lockout, sudo/re-auth mode,
   auth-event auditing + anomaly alerting.
3. **RBAC & SoD:** separation of duties (approver ≠ configurer), deny-by-default,
   admin-mode HubSpot ops behind a dedicated role.
4. **Prompt-injection hardening:** reader/actor separation, output-side injection
   scanning, delimiter/control-char sanitization, quarantine-don't-drop,
   per-source token/length caps.
5. **Credentials & secrets:** short-lived auto-rotated tokens, log/audit
   redaction before write, app-level envelope encryption, egress allowlist
   enforced at app/worker level.
6. **Repo-scoring sandbox:** isolated network-restricted ephemeral ingestion,
   resource caps, never execute repo content.
7. **Audit-log integrity:** hash-chain each entry, append-only DB permissions,
   off-box shipping.
8. **Operational safeguards:** dependency + secret scanning in CI, incident
   kill-switch.

## Shared core: agent framework

Six board agents + Orchestrator/Router — Orchestrator/Router, Project Manager,
HubSpot Admin, Security, Data Quality/Extraction, Dev, CTO/Architect. Strict-JSON
verdict contract, schema-validated; prompts/model/enabled editable from console,
stored in Postgres, **versioned**. Independent agents run in parallel; resolution
via the **safe/unsafe config table**; **Security veto non-overridable on its own
domain**; **CTO breaks non-security ties**. Subjects proceed only if all required
agents `pass` (or auto-fixed to pass). Everything logged to audit.

## Product A — Meeting→Task Engine

Webhook receiver → reconciliation backstop → Fireflies fetch → Anthropic
extraction (strict JSON) → owner resolution (privileged, admin-mode, isolated) →
reconciliation (update-or-create, no duplicates) → batched board (one call per
agent for all of a meeting's tasks) → HubSpot sync via Agent CLI with
`--dry-run` preview, board-approved only, Projects API fallback → query agent
(filtered reads + ledger provenance).

## Product B — Repo Scoring

Ingest (sandboxed, untrusted) → Security pre-scan before any content reaches
Anthropic → Dev + Security + CTO board → aggregated scorecard → console view +
audit persist. On-demand only.

## Admin console

- **Agents:** edit prompt/model/enabled; edit safe/unsafe table; version history
  (SoD: editing disables self-approval).
- **Triggers:** webhooks, cron, on-demand "run now"; idempotent/locking scheduler.
- **Escalation queue:** review → approve (sync) / reject (discard); approver ≠
  configurer.
- **Audit log viewer:** searchable; shows hash-chain integrity status.
- **Repo scoring:** submit repo, view scorecards.
- **Security/admin panel:** user & role management, MFA enrollment, session
  revocation, kill-switch toggle, credential-rotation status, retention/purge.

## Build order

**v1:** (1) scaffold + config/secrets + schema; (2) shared core: agent contract +
validation, orchestrator (Security veto), safe/unsafe table, hash-chained audit
log + off-box shipping; (3) governance primitives; (4) trigger registry; (5)
HubSpot integration; (6) Product A full path; (7) admin console; (8) DO deploy.
**v2:** (9) Product B sandboxed repo scoring.
**Compliance track (org-owned):** risk assessment + SoA (27001 & 42001), AI
impact assessment per product (42001), documented QMS (9001), internal audit +
management review.

## Remaining confirmations (non-blocking)

- HubSpot Hub/tier: Projects object availability; OAuth scopes provisioned.
- Fireflies API plan/scopes.
- Whether transcripts/email already live in HubSpot.
- Certification body selection per standard and target audit dates; integrated
  audit across all three?

---

For the full ISO control mapping see [`COMPLIANCE.md`](COMPLIANCE.md); for the
security control detail see [`SECURITY.md`](SECURITY.md).
