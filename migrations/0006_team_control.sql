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
