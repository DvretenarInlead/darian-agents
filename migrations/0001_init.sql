-- ============================================================================
-- Migration 0001 — initial schema
-- darian-agents: shared agent-orchestration platform
--
-- Mirrors the "Updated Postgres schema" in the v2 build brief. Security-relevant
-- tables: users/roles/sessions, webhook replay/idempotency, and the immutable
-- hash-chained audit log. Grants at the bottom enforce the append-only audit
-- role (ISO 27001 A.8.15 Logging, A.5.28 Collection of evidence).
-- ============================================================================

-- Extensions required by the schema.
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";   -- case-insensitive email

-- ============ Console identity & access ============
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,                  -- argon2id
  status          TEXT NOT NULL DEFAULT 'active', -- active|locked|disabled
  failed_attempts INT  NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  mfa_secret_enc  BYTEA,                           -- TOTP seed, envelope-encrypted
  mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_status_chk CHECK (status IN ('active', 'locked', 'disabled'))
);

CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT UNIQUE NOT NULL,                -- admin, approver, configurer, viewer, hubspot_admin_mode
  permissions JSONB NOT NULL DEFAULT '[]'          -- deny-by-default; explicit grants only
);

CREATE TABLE user_roles (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Separation-of-duties: whoever configured a subject cannot approve it.
CREATE TABLE sod_action_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id  TEXT NOT NULL,
  action      TEXT NOT NULL,                       -- configured|approved|rejected
  actor_id    UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sod_action_chk CHECK (action IN ('configured', 'approved', 'rejected'))
);
CREATE INDEX sod_action_log_subject_idx ON sod_action_log (subject_id);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash  TEXT NOT NULL,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_expires  TIMESTAMPTZ NOT NULL,
  abs_expires   TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  sudo_until    TIMESTAMPTZ                          -- re-auth window for high-impact actions
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ============ Webhook replay / idempotency ============
CREATE TABLE webhook_deliveries (
  delivery_id   TEXT PRIMARY KEY,                   -- nonce / provider delivery ID
  meeting_id    TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_ok  BOOLEAN NOT NULL,
  ts_in_window  BOOLEAN NOT NULL                    -- timestamp tolerance check
);

-- ============ Immutable, tamper-evident audit log ============
-- App role granted INSERT + SELECT only (no UPDATE/DELETE) — see grants below.
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,                        -- ingest|verdict|autofix|escalation|approval|external_write|config_change|auth_event
  product     TEXT,                                 -- meeting|repo|console
  actor_id    UUID REFERENCES users(id),
  subject_id  TEXT,
  payload     JSONB NOT NULL,                       -- secret-scanned + redacted before insert
  prev_hash   TEXT,                                 -- hash of previous row
  row_hash    TEXT NOT NULL,                        -- hash(prev_hash || canonical(payload || meta))
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_event_type_idx ON audit_log (event_type);
CREATE INDEX audit_log_product_idx ON audit_log (product);
CREATE INDEX audit_log_subject_idx ON audit_log (subject_id);

-- ============ Shared core: agents & policy ============
CREATE TABLE agent_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  model       TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  version     INT  NOT NULL DEFAULT 1,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One enabled config row per (agent, version); look-ups fetch the max version.
CREATE UNIQUE INDEX agent_configs_agent_version_idx ON agent_configs (agent, version);

CREATE TABLE resolution_policy (                     -- safe/unsafe table
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  condition   TEXT NOT NULL,
  disposition TEXT NOT NULL,                         -- auto_fix|escalate
  reversible  BOOLEAN NOT NULL,
  version     INT NOT NULL DEFAULT 1,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT resolution_disposition_chk CHECK (disposition IN ('auto_fix', 'escalate'))
);

-- ============ Product A — reconciliation & sync ============
CREATE TABLE reconciliation_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    TEXT NOT NULL,
  item_hash     TEXT NOT NULL,                       -- normalized for dedupe
  hubspot_obj   TEXT,                                -- project/task id once synced
  decision      TEXT NOT NULL,                       -- created|updated|skipped_duplicate
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, item_hash),
  CONSTRAINT recon_decision_chk CHECK (decision IN ('created', 'updated', 'skipped_duplicate'))
);

CREATE TABLE escalation_queue (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product     TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  verdicts    JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',       -- pending|approved|rejected
  decided_by  UUID REFERENCES users(id),
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT escalation_status_chk CHECK (status IN ('pending', 'approved', 'rejected'))
);
CREATE INDEX escalation_queue_status_idx ON escalation_queue (status);

CREATE TABLE sync_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id  TEXT NOT NULL,
  dry_run     BOOLEAN NOT NULL,
  outcome     TEXT NOT NULL,                          -- previewed|applied|failed
  hubspot_ref TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sync_outcome_chk CHECK (outcome IN ('previewed', 'applied', 'failed'))
);

-- ============ Sensitive raw data — envelope-encrypted ============
CREATE TABLE raw_artifacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT NOT NULL,                       -- fireflies|github
  external_id    TEXT NOT NULL,
  content_enc    BYTEA NOT NULL,                      -- app-level envelope encryption
  retained_until TIMESTAMPTZ,                         -- retention/purge driver
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT raw_artifacts_source_chk CHECK (source IN ('fireflies', 'github'))
);
CREATE INDEX raw_artifacts_retained_until_idx ON raw_artifacts (retained_until);

-- ============ Triggers ============
CREATE TABLE trigger_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,                          -- webhook|cron|on_demand
  spec        JSONB NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trigger_kind_chk CHECK (kind IN ('webhook', 'cron', 'on_demand'))
);

-- ============================================================================
-- Append-only enforcement for the audit log.
--
-- The application connects as role `app_rw`. That role may INSERT and SELECT
-- the audit_log but is explicitly denied UPDATE and DELETE, so a console
-- compromise cannot rewrite history in-place. Combined with the per-row
-- hash chain (prev_hash/row_hash) this makes tampering detectable, and
-- off-box shipping keeps an external copy.
--
-- Run once, out of band, by a migration/admin role that owns the tables:
--   CREATE ROLE app_rw LOGIN PASSWORD '...';
-- The grants below assume app_rw exists. They are guarded so the migration
-- does not fail in environments where the role has not been provisioned yet.
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    -- Full DML on operational tables.
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      users, roles, user_roles, sod_action_log, sessions, webhook_deliveries,
      agent_configs, resolution_policy, reconciliation_ledger, escalation_queue,
      sync_log, raw_artifacts, trigger_configs
      TO app_rw;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

    -- Audit log: append + read only. No UPDATE/DELETE.
    GRANT SELECT, INSERT ON audit_log TO app_rw;
    GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO app_rw;
    REVOKE UPDATE, DELETE ON audit_log FROM app_rw;
  END IF;
END
$$;
