# Security model

This platform's highest-risk surfaces are (1) the roll-your-own console auth and
(2) untrusted input flowing into LLM prompts. The controls below mirror the v2
build brief's security sections. Items marked **(foundation)** have code landed;
the rest are committed designs scheduled in later build-order steps.

## 1. Webhook & ingestion hardening (Product A)
- **Replay protection:** timestamp tolerance window (default 300 s, configurable)
  **and** a `webhook_deliveries` dedupe table keyed on provider delivery ID/nonce.
- **Constant-time signature comparison** via `crypto.timingSafeEqual` — never
  `===` on HMACs.
- **Payload size + rate limits** at the receiver, before the worker.
- **TLS verification pinned** on all outbound calls; reject invalid/downgraded
  certs. (DB pool already sets `rejectUnauthorized: true` when SSL is on.) **(foundation)**

## 2. Console auth (roll-your-own)
- **MFA / TOTP** required for all privileged accounts (`users.mfa_secret_enc`,
  envelope-encrypted).
- **Password policy + breach check** at set-time (zxcvbn + HaveIBeenPwned
  k-anonymity range query). Hash with **argon2id**.
- **Session hardening:** short-lived access + rotating refresh tokens;
  `httpOnly`/`Secure`/`SameSite` cookies; server-side revocation
  (`sessions.revoked_at`); idle + absolute timeouts; rotate session on privilege
  change. TTLs are configurable. **(foundation: config + schema)**
- **CSRF protection** on every state-changing console route.
- **Enumeration-resistant lockout:** identical timing/messaging for unknown-user
  vs bad-password; throttle by IP **and** account.
- **Sudo / re-auth mode** (`sessions.sudo_until`) before high-impact actions.
- **Auth event auditing + anomaly alerting** (`audit_log` event_type `auth_event`).

## 3. RBAC & separation of duties
- **Deny-by-default** permissions; explicit grants only (`roles.permissions`).
- **Separation of duties:** the identity that configures an agent prompt or the
  safe/unsafe table **cannot self-approve** its own escalations. Enforced in code
  and evidenced in `sod_action_log` (configured ≠ approved actor).
- **Admin-mode (service-key) HubSpot ops** gated behind a dedicated
  `hubspot_admin_mode` role, distinct from ordinary console admin.

## 4. Prompt-injection hardening
- **Reader/actor separation** in the agent contract — agents never act. **(foundation)**
- **Output-side injection scanning:** every agent's free-text output is untrusted
  to the next stage; `scanForInjection()` flags smuggling patterns. **(foundation)**
- **Delimiter & control-char sanitization** of untrusted text before it enters a
  prompt (`sanitize()`). **(foundation)**
- **Quarantine, don't drop:** malformed/suspicious output is persisted to audit
  for forensics. The verdict parser returns a quarantine-able result rather than
  throwing. **(foundation)**
- **Per-source token/length caps** to resist context-stuffing
  (`FREE_TEXT_MAX`, `MAX_ISSUES`). **(foundation)**

## 5. Credentials & secrets
- Short-lived, auto-rotated tokens where supported; documented rotation cadence
  for the broad-permission HubSpot service key.
- **Log/audit redaction:** secret-scan structured logs and audit payloads and
  redact **before** write.
- **App-level envelope encryption** for the most sensitive tiers (raw
  transcripts/repo content in `raw_artifacts.content_enc`, TOTP seeds), above DO
  disk encryption. Keyed by `ENVELOPE_MASTER_KEY` + `ENVELOPE_KEY_VERSION`.
- **Egress allowlist enforced at app/worker level** (`EGRESS_ALLOWLIST`), not
  just documented. **(foundation: config)**

## 6. Repo-scoring sandbox (Product B)
- Clone/read in an **isolated, network-restricted, ephemeral** context.
- **Resource caps** on repo size, file count, per-file size before scan.
- **Never execute repo content** — read-only parsing; no build/install/run.
- Symlink-traversal, path-escape filename, and zip-bomb defences on ingest.

## 7. Audit-log integrity
- **Hash-chain** each entry (`prev_hash`/`row_hash`) → deletions/edits detectable.
  Pure, unit-tested helper. **(foundation)**
- **Append-only DB permissions** for the app role (no UPDATE/DELETE on
  `audit_log`), granted in `0001_init.sql`. **(foundation)**
- **Off-box shipping** of audit events (`AUDIT_SHIP_ENDPOINT`).

## 8. Operational safeguards
- **Dependency + secret scanning in CI** — the HubSpot Agent CLI is fast-moving
  beta, so pin *and* monitor advisories.
- **Incident kill-switch:** one toggle disables all external writes (HubSpot
  sync, email) and freezes triggers if compromise is suspected.

## Reporting

Security issues should be reported privately to the platform owner. Do not open
public issues for suspected vulnerabilities.
